import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  installConsoleCapture,
  type FrameMeta,
  type Disposer,
} from '../../src/captures/capture_console.js';
import { installFetchCapture } from '../../src/captures/capture_fetch.js';
import { installXhrCapture } from '../../src/captures/capture_xhr.js';
import { installWebSocketCapture } from '../../src/captures/capture_websocket.js';
import {
  PAGE_EVENT_SW_TAG,
  createCsDispatcher,
  type PageEventSwMessage,
} from '../../src/page_bridge/cs_dispatcher.js';
import {
  createEventSink,
  isPageEventSwMessage,
} from '../../src/sw_event_sink/sw_event_sink.js';
import {
  encodeEvent,
  type PageBridgeEventEnvelope,
} from '../../src/page_bridge/protocol.js';
import type { CapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://chainsale.app/',
  frameKey: 'top',
};

class FakeXHR extends EventTarget {
  status = 0;
  responseType: XMLHttpRequestResponseType = '';
  responseText = '';
  response: unknown = '';
  open(_method: string, _url: string): void {}
  setRequestHeader(_name: string, _value: string): void {}
  send(_body?: unknown): void {}
  resolve(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.response = body;
    this.dispatchEvent(new Event('load'));
  }
}

class FakeWS extends EventTarget {
  url: string;
  constructor(url: string | URL) {
    super();
    this.url = typeof url === 'string' ? url : url.toString();
  }
  send(_data: unknown): void {}
  emitOpen(): void {
    this.dispatchEvent(new Event('open'));
  }
  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

const buildPipeline = (): {
  emit: (event: CapturedEvent) => void;
  sink: ReturnType<typeof createEventSink>;
  tags: string[];
} => {
  const sink = createEventSink();
  const tags: string[] = [];
  const dispatcher = createCsDispatcher({
    forwardEventToSw: (msg: PageEventSwMessage) => {
      tags.push(msg.tag);
      if (isPageEventSwMessage(msg)) {
        sink.handle(msg.event as CapturedEvent);
      }
    },
  });
  const emit = (event: CapturedEvent): void => {
    const envelope: PageBridgeEventEnvelope<CapturedEvent> =
      encodeEvent<CapturedEvent>(event);
    dispatcher.handlePageMessage(
      new MessageEvent('message', {
        data: envelope,
        source: window as MessageEventSource,
      }),
    );
  };
  return { emit, sink, tags };
};

describe('captures integration: 4 producers coexist on shared emit', () => {
  let disposers: Disposer[] = [];
  const realFetch = globalThis.fetch;
  const realXhr = globalThis.XMLHttpRequest;
  const realWs = globalThis.WebSocket;

  afterEach(() => {
    for (const d of disposers) d();
    disposers = [];
    globalThis.fetch = realFetch;
    globalThis.XMLHttpRequest = realXhr;
    globalThis.WebSocket = realWs;
    vi.restoreAllMocks();
  });

  it('one event per kind reaches the sink with no cross-talk', async () => {
    const { emit, sink } = buildPipeline();

    globalThis.fetch = vi.fn(async () =>
      new Response('hi', { status: 200 }),
    ) as typeof globalThis.fetch;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;

    disposers = [
      installConsoleCapture(emit, FRAME, { now: () => 1 }),
      installFetchCapture(emit, FRAME, { now: () => 1 }),
      installXhrCapture(emit, FRAME, { now: () => 1 }),
      installWebSocketCapture(emit, FRAME, { now: () => 1 }),
    ];

    console.log('boot');
    await fetch('https://api.example.com/x');
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('GET', '/x');
    xhr.send();
    xhr.resolve(200, 'ok');
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.emitOpen();
    ws.emitMessage('hi');

    const stats = sink.getStats();
    expect(stats.perKind['console']).toBe(1);
    // fetch: paired request+response
    expect(stats.perKind['fetch']).toBe(2);
    // xhr: paired request+response
    expect(stats.perKind['xhr']).toBe(2);
    // websocket: open + receive frame
    expect(stats.perKind['websocket']).toBe(2);
    expect(stats.totalReceived).toBe(7);
  });

  it('captureId / connectionId values are distinct across calls and producers', async () => {
    const { emit, sink } = buildPipeline();

    globalThis.fetch = vi.fn(async () =>
      new Response('a'),
    ) as typeof globalThis.fetch;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;

    disposers = [
      installFetchCapture(emit, FRAME),
      installXhrCapture(emit, FRAME),
      installWebSocketCapture(emit, FRAME),
    ];

    await Promise.all([
      fetch('https://api.example.com/a'),
      fetch('https://api.example.com/b'),
    ]);
    const x1 = new XMLHttpRequest() as unknown as FakeXHR;
    const x2 = new XMLHttpRequest() as unknown as FakeXHR;
    x1.open('GET', '/u1');
    x1.send();
    x2.open('GET', '/u2');
    x2.send();
    const w1 = new WebSocket('wss://echo.example/a') as unknown as FakeWS;
    const w2 = new WebSocket('wss://echo.example/b') as unknown as FakeWS;
    w1.emitOpen();
    w2.emitOpen();

    const events: CapturedEvent[] = [];
    sink.getRecent({ kinds: ['fetch', 'xhr', 'websocket'] }).events.forEach((e) => {
      events.push(e);
    });

    const fetchIds = events
      .filter((e) => e.kind === 'fetch' && e.phase === 'request')
      .map((e) => (e as { captureId: string }).captureId);
    expect(new Set(fetchIds).size).toBe(2);

    const xhrIds = events
      .filter((e) => e.kind === 'xhr' && e.phase === 'request')
      .map((e) => (e as { captureId: string }).captureId);
    expect(new Set(xhrIds).size).toBe(2);

    const wsIds = events
      .filter((e) => e.kind === 'websocket' && e.subkind === 'open')
      .map((e) => (e as { connectionId: string }).connectionId);
    expect(new Set(wsIds).size).toBe(2);

    // Cross-producer: no fetch captureId should collide with an xhr captureId
    expect(fetchIds.some((id) => xhrIds.includes(id))).toBe(false);
  });

  it('all events flow through the same emit closure (canonical SW tag)', async () => {
    const { emit, tags } = buildPipeline();

    globalThis.fetch = vi.fn(async () =>
      new Response('ok'),
    ) as typeof globalThis.fetch;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;

    disposers = [
      installConsoleCapture(emit, FRAME),
      installFetchCapture(emit, FRAME),
      installXhrCapture(emit, FRAME),
      installWebSocketCapture(emit, FRAME),
    ];

    console.log('a');
    await fetch('https://api.example.com/x');
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('GET', '/x');
    xhr.send();
    xhr.resolve(200, 'ok');
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.emitOpen();

    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((t) => t === PAGE_EVENT_SW_TAG)).toBe(true);
  });

  it('disposers cleanly restore window.fetch, XMLHttpRequest, WebSocket, and console.* originals', () => {
    const { emit } = buildPipeline();
    globalThis.fetch =
      globalThis.fetch ?? (vi.fn(async () => new Response('')) as typeof globalThis.fetch);
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
    const baselineFetch = globalThis.fetch;
    const baselineXhr = globalThis.XMLHttpRequest;
    const baselineWs = globalThis.WebSocket;
    const baselineLog = console.log;

    disposers = [
      installConsoleCapture(emit, FRAME),
      installFetchCapture(emit, FRAME),
      installXhrCapture(emit, FRAME),
      installWebSocketCapture(emit, FRAME),
    ];

    expect(globalThis.fetch).not.toBe(baselineFetch);
    expect(globalThis.XMLHttpRequest).not.toBe(baselineXhr);
    expect(globalThis.WebSocket).not.toBe(baselineWs);
    expect(console.log).not.toBe(baselineLog);

    for (const d of disposers) d();
    disposers = [];

    expect(globalThis.fetch).toBe(baselineFetch);
    expect(globalThis.XMLHttpRequest).toBe(baselineXhr);
    expect(globalThis.WebSocket).toBe(baselineWs);
    expect(console.log).toBe(baselineLog);
  });
});
