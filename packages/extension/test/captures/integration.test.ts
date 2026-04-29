import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  installConsoleCapture,
  type FrameMeta,
} from '../../src/captures/capture_console.js';
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
import type { CapturedEvent, ConsoleCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://chainsale.app/',
  frameKey: 'top',
};

describe('captures integration: page-world → CS relay → SW sink', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    if (dispose) {
      dispose();
      dispose = undefined;
    }
    vi.restoreAllMocks();
  });

  it('one console.log produces exactly one event in the SW sink', () => {
    // SW side: a sink instance with no logger.
    const sink = createEventSink();

    // CS side: a dispatcher whose forward strategy hands events to sink.handle
    // (instead of going through chrome.runtime.sendMessage).
    const dispatcher = createCsDispatcher({
      forwardEventToSw: (msg: PageEventSwMessage) => {
        if (isPageEventSwMessage(msg)) {
          sink.handle(msg.event as CapturedEvent);
        }
      },
    });

    // Page-world side: install console capture; emit posts the encoded
    // envelope through the dispatcher's window.message listener so we exercise
    // the same code path the real CS would use.
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

    dispose = installConsoleCapture(emit, FRAME, { now: () => 1234 });

    console.log('hello', { x: 1 });

    const stats = sink.getStats();
    expect(stats.totalReceived).toBe(1);
    expect(stats.perKind['console']).toBe(1);
  });

  it('payload reaches the sink intact (kind, level, args, frame, ts)', () => {
    const received: CapturedEvent[] = [];
    const sink = createEventSink({ logger: (e) => received.push(e) });
    const dispatcher = createCsDispatcher({
      forwardEventToSw: (msg) => {
        sink.handle(msg.event as CapturedEvent);
      },
    });
    const emit = (event: CapturedEvent): void => {
      dispatcher.handlePageMessage(
        new MessageEvent('message', {
          data: encodeEvent<CapturedEvent>(event),
          source: window as MessageEventSource,
        }),
      );
    };
    dispose = installConsoleCapture(emit, FRAME, { now: () => 99 });

    console.log('hi', 42);

    expect(received).toHaveLength(1);
    const evt = received[0] as ConsoleCapturedEvent;
    expect(evt.kind).toBe('console');
    expect(evt.level).toBe('log');
    expect(evt.args).toEqual(['hi', 42]);
    expect(evt.frameUrl).toBe(FRAME.frameUrl);
    expect(evt.frameKey).toBe(FRAME.frameKey);
    expect(evt.ts).toBe(99);
  });

  it('the SW message has the canonical PAGE_EVENT_SW_TAG so the SW listener filter passes', () => {
    const tags: string[] = [];
    const dispatcher = createCsDispatcher({
      forwardEventToSw: (msg) => {
        tags.push(msg.tag);
      },
    });
    const emit = (event: CapturedEvent): void => {
      dispatcher.handlePageMessage(
        new MessageEvent('message', {
          data: encodeEvent<CapturedEvent>(event),
          source: window as MessageEventSource,
        }),
      );
    };
    dispose = installConsoleCapture(emit, FRAME);
    console.log('go');
    expect(tags).toEqual([PAGE_EVENT_SW_TAG]);
  });
});
