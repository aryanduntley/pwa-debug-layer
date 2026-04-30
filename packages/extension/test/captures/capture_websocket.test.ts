import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installWebSocketCapture } from '../../src/captures/capture_websocket.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type { WebSocketCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://example.com/x',
  frameKey: 'top',
};

class FakeWS extends EventTarget {
  url: string;
  sent: unknown[] = [];

  constructor(url: string | URL) {
    super();
    this.url = typeof url === 'string' ? url : url.toString();
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  emitOpen(): void {
    this.dispatchEvent(new Event('open'));
  }
  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  emitClose(code = 1000, reason = ''): void {
    const event = new Event('close');
    Object.assign(event, { code, reason, wasClean: true });
    this.dispatchEvent(event);
  }
  emitError(): void {
    this.dispatchEvent(new Event('error'));
  }
}

describe('installWebSocketCapture', () => {
  let received: WebSocketCapturedEvent[];
  let dispose: (() => void) | undefined;
  const realWs = globalThis.WebSocket;

  beforeEach(() => {
    received = [];
    dispose = undefined;
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
    dispose = installWebSocketCapture(
      (e) => {
        received.push(e);
      },
      FRAME,
    );
  });

  afterEach(() => {
    if (dispose) dispose();
    globalThis.WebSocket = realWs;
  });

  it('emits open subkind with url and connectionId', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.emitOpen();

    expect(received).toHaveLength(1);
    expect(received[0]!.subkind).toBe('open');
    expect(received[0]!.url).toBe('wss://echo.example/x');
    expect(typeof received[0]!.connectionId).toBe('string');
  });

  it('emits frame subkind on send (direction:send, text frame)', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.send('hello');

    const frames = received.filter((e) => e.subkind === 'frame');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.direction).toBe('send');
    expect(frames[0]!.frameType).toBe('text');
    expect(frames[0]!.data).toBe('hello');
    expect(ws.sent).toEqual(['hello']);
  });

  it('emits frame subkind on message (direction:receive)', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.emitMessage('hi back');

    const frames = received.filter((e) => e.subkind === 'frame');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.direction).toBe('receive');
    expect(frames[0]!.frameType).toBe('text');
    expect(frames[0]!.data).toBe('hi back');
  });

  it('tags binary frames as Binary with byteLength (ArrayBuffer)', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    const buf = new ArrayBuffer(12);
    ws.send(buf);
    ws.emitMessage(new ArrayBuffer(7));

    const frames = received.filter((e) => e.subkind === 'frame');
    expect(frames).toHaveLength(2);
    expect(frames[0]!.frameType).toBe('binary');
    expect((frames[0]!.data as { __type: string }).__type).toBe('Binary');
    expect((frames[0]!.data as { byteLength: number }).byteLength).toBe(12);
    expect(frames[1]!.frameType).toBe('binary');
    expect((frames[1]!.data as { byteLength: number }).byteLength).toBe(7);
  });

  it('tags Blob frames as Binary with blob.size', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    const blob = new Blob(['ABCDE']);
    ws.send(blob as unknown as ArrayBufferLike);

    const frames = received.filter((e) => e.subkind === 'frame');
    expect(frames[0]!.frameType).toBe('binary');
    expect((frames[0]!.data as { byteLength: number }).byteLength).toBe(5);
  });

  it('truncates large text frames via serializeArgs maxBytes', () => {
    if (dispose) dispose();
    dispose = installWebSocketCapture(
      (e) => {
        received.push(e);
      },
      FRAME,
      { maxBytes: 50 },
    );
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.send('y'.repeat(500));

    const frames = received.filter((e) => e.subkind === 'frame');
    expect((frames[0]!.data as { __type?: string }).__type).toBe('Truncated');
  });

  it('emits close subkind with code and reason', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.emitClose(1006, 'gone');

    const close = received.find((e) => e.subkind === 'close')!;
    expect(close.code).toBe(1006);
    expect(close.reason).toBe('gone');
  });

  it('omits close.reason when empty string', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.emitClose(1000, '');

    const close = received.find((e) => e.subkind === 'close')!;
    expect(close.code).toBe(1000);
    expect(close.reason).toBeUndefined();
  });

  it('emits error subkind on error event', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.emitError();

    const err = received.find((e) => e.subkind === 'error')!;
    expect(err.subkind).toBe('error');
  });

  it('multiple concurrent connections get distinct connectionIds', () => {
    const a = new WebSocket('wss://echo.example/a') as unknown as FakeWS;
    const b = new WebSocket('wss://echo.example/b') as unknown as FakeWS;
    const c = new WebSocket('wss://echo.example/c') as unknown as FakeWS;
    a.emitOpen();
    b.emitOpen();
    c.emitOpen();

    const opens = received.filter((e) => e.subkind === 'open');
    expect(new Set(opens.map((e) => e.connectionId)).size).toBe(3);
  });

  it('disposer restores the original WebSocket and is idempotent', () => {
    const wrapped = globalThis.WebSocket;
    expect(wrapped).not.toBe(FakeWS);

    dispose!();
    expect(globalThis.WebSocket).toBe(FakeWS as unknown as typeof WebSocket);

    dispose!();
    expect(globalThis.WebSocket).toBe(FakeWS as unknown as typeof WebSocket);
  });

  it('full lifecycle: open → send → receive → close emits 4 events with same connectionId', () => {
    const ws = new WebSocket('wss://echo.example/x') as unknown as FakeWS;
    ws.emitOpen();
    ws.send('ping');
    ws.emitMessage('pong');
    ws.emitClose(1000, '');

    expect(received).toHaveLength(4);
    expect(received.map((e) => e.subkind)).toEqual([
      'open',
      'frame',
      'frame',
      'close',
    ]);
    const id = received[0]!.connectionId;
    expect(received.every((e) => e.connectionId === id)).toBe(true);
  });
});
