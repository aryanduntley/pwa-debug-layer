import { serializeArgs } from './serialize.js';
import type { Disposer, FrameMeta } from './capture_console.js';
import type { WebSocketCapturedEvent } from './types.js';

export type WebSocketCaptureOptions = {
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly idGen?: () => string;
};

type InstanceState = {
  connectionId: string;
  url: string;
};

const defaultIdGen = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const tagBinary = (byteLength: number): unknown => ({
  __type: 'Binary' as const,
  byteLength,
});

const serializeTextFrame = (
  data: string,
  maxBytes: number | undefined,
): unknown => {
  const opts = maxBytes === undefined ? undefined : { maxBytes };
  return serializeArgs([data], opts).serialized[0];
};

type FrameProjection = {
  readonly frameType: 'text' | 'binary';
  readonly data: unknown;
};

const projectFrame = (
  data: unknown,
  maxBytes: number | undefined,
): FrameProjection => {
  if (typeof data === 'string') {
    return { frameType: 'text', data: serializeTextFrame(data, maxBytes) };
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return { frameType: 'binary', data: tagBinary(data.size) };
  }
  if (data instanceof ArrayBuffer) {
    return { frameType: 'binary', data: tagBinary(data.byteLength) };
  }
  if (ArrayBuffer.isView(data)) {
    return { frameType: 'binary', data: tagBinary(data.byteLength) };
  }
  return { frameType: 'binary', data: tagBinary(0) };
};

export const installWebSocketCapture = (
  emit: (event: WebSocketCapturedEvent) => void,
  frame: FrameMeta,
  opts?: WebSocketCaptureOptions,
): Disposer => {
  const Original = globalThis.WebSocket;
  if (typeof Original !== 'function') return () => {};
  const now = opts?.now ?? (() => Date.now());
  const idGen = opts?.idGen ?? defaultIdGen;
  const maxBytes = opts?.maxBytes;
  const states = new WeakMap<WebSocket, InstanceState>();

  const tryEmit = (event: WebSocketCapturedEvent): void => {
    try {
      emit(event);
    } catch {
      // Capture failure must never break the page's WebSocket.
    }
  };

  const Wrapped = new Proxy(Original, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget) as WebSocket;
      const url =
        typeof args[0] === 'string'
          ? args[0]
          : args[0] instanceof URL
            ? args[0].toString()
            : (ws.url ?? '');
      const state: InstanceState = {
        connectionId: idGen(),
        url,
      };
      states.set(ws, state);

      const origSend = ws.send;
      ws.send = function patchedSend(
        this: WebSocket,
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ): void {
        const s = states.get(this);
        if (s !== undefined) {
          let projected: FrameProjection;
          try {
            projected = projectFrame(data, maxBytes);
          } catch {
            projected = { frameType: 'binary', data: tagBinary(0) };
          }
          tryEmit(
            Object.freeze({
              kind: 'websocket',
              ts: now(),
              frameUrl: frame.frameUrl,
              frameKey: frame.frameKey,
              subkind: 'frame',
              connectionId: s.connectionId,
              direction: 'send',
              frameType: projected.frameType,
              data: projected.data,
            }) as WebSocketCapturedEvent,
          );
        }
        return origSend.call(this, data);
      } as WebSocket['send'];

      ws.addEventListener('open', () => {
        const s = states.get(ws);
        if (s === undefined) return;
        tryEmit(
          Object.freeze({
            kind: 'websocket',
            ts: now(),
            frameUrl: frame.frameUrl,
            frameKey: frame.frameKey,
            subkind: 'open',
            connectionId: s.connectionId,
            url: s.url,
          }) as WebSocketCapturedEvent,
        );
      });

      ws.addEventListener('message', (event: Event) => {
        const s = states.get(ws);
        if (s === undefined) return;
        const msg = event as MessageEvent;
        let projected: FrameProjection;
        try {
          projected = projectFrame(msg.data, maxBytes);
        } catch {
          projected = { frameType: 'binary', data: tagBinary(0) };
        }
        tryEmit(
          Object.freeze({
            kind: 'websocket',
            ts: now(),
            frameUrl: frame.frameUrl,
            frameKey: frame.frameKey,
            subkind: 'frame',
            connectionId: s.connectionId,
            direction: 'receive',
            frameType: projected.frameType,
            data: projected.data,
          }) as WebSocketCapturedEvent,
        );
      });

      ws.addEventListener('close', (event: Event) => {
        const s = states.get(ws);
        if (s === undefined) return;
        const closeEvt = event as CloseEvent;
        tryEmit(
          Object.freeze({
            kind: 'websocket',
            ts: now(),
            frameUrl: frame.frameUrl,
            frameKey: frame.frameKey,
            subkind: 'close',
            connectionId: s.connectionId,
            ...(typeof closeEvt.code === 'number'
              ? { code: closeEvt.code }
              : {}),
            ...(typeof closeEvt.reason === 'string' && closeEvt.reason.length > 0
              ? { reason: closeEvt.reason }
              : {}),
          }) as WebSocketCapturedEvent,
        );
      });

      ws.addEventListener('error', () => {
        const s = states.get(ws);
        if (s === undefined) return;
        tryEmit(
          Object.freeze({
            kind: 'websocket',
            ts: now(),
            frameUrl: frame.frameUrl,
            frameKey: frame.frameKey,
            subkind: 'error',
            connectionId: s.connectionId,
          }) as WebSocketCapturedEvent,
        );
      });

      return ws;
    },
  });

  globalThis.WebSocket = Wrapped as typeof WebSocket;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    globalThis.WebSocket = Original;
  };
};
