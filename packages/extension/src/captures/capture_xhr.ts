import { serializeArgs } from './serialize.js';
import type { Disposer, FrameMeta } from './capture_console.js';
import type { XhrCapturedEvent } from './types.js';

export type XhrCaptureOptions = {
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly idGen?: () => string;
};

type InstanceState = {
  captureId: string;
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string>;
  startTs: number;
};

const defaultIdGen = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  return `x_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const tagBlob = (b: Blob): unknown => ({
  __type: 'Blob' as const,
  size: b.size,
  type: b.type,
});

const tagArrayBuffer = (buf: ArrayBuffer): unknown => ({
  __type: 'ArrayBuffer' as const,
  byteLength: buf.byteLength,
});

const tagStream = (): unknown => ({ __type: 'ReadableStream' as const });

const tagFormData = (): unknown => ({ __type: 'FormData' as const });

const tagUrlParams = (p: URLSearchParams): unknown => ({
  __type: 'URLSearchParams' as const,
  value: p.toString(),
});

const serializeRequestBody = (
  body: unknown,
  maxBytes: number | undefined,
): unknown => {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') {
    const opts = maxBytes === undefined ? undefined : { maxBytes };
    return serializeArgs([body], opts).serialized[0];
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return tagBlob(body);
  if (
    typeof URLSearchParams !== 'undefined' &&
    body instanceof URLSearchParams
  ) {
    return tagUrlParams(body);
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return tagFormData();
  }
  if (body instanceof ArrayBuffer) return tagArrayBuffer(body);
  if (ArrayBuffer.isView(body)) return tagArrayBuffer((body as ArrayBufferView).buffer as ArrayBuffer);
  if (typeof Document !== 'undefined' && body instanceof Document) {
    return { __type: 'Document' as const };
  }
  return tagStream();
};

const readResponseBody = (
  xhr: XMLHttpRequest,
  maxBytes: number | undefined,
): unknown => {
  const rt = xhr.responseType;
  try {
    if (rt === '' || rt === 'text') {
      const text = xhr.responseText ?? '';
      const opts = maxBytes === undefined ? undefined : { maxBytes };
      return serializeArgs([text], opts).serialized[0];
    }
    if (rt === 'json') {
      const opts = maxBytes === undefined ? undefined : { maxBytes };
      return serializeArgs([xhr.response], opts).serialized[0];
    }
    if (rt === 'blob') {
      const blob = xhr.response as Blob | null;
      return blob === null ? undefined : tagBlob(blob);
    }
    if (rt === 'arraybuffer') {
      const buf = xhr.response as ArrayBuffer | null;
      return buf === null ? undefined : tagArrayBuffer(buf);
    }
    if (rt === 'document') {
      return { __type: 'Document' as const };
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const installXhrCapture = (
  emit: (event: XhrCapturedEvent) => void,
  frame: FrameMeta,
  opts?: XhrCaptureOptions,
): Disposer => {
  const Original = globalThis.XMLHttpRequest;
  if (typeof Original !== 'function') return () => {};
  const now = opts?.now ?? (() => Date.now());
  const idGen = opts?.idGen ?? defaultIdGen;
  const maxBytes = opts?.maxBytes;
  const states = new WeakMap<XMLHttpRequest, InstanceState>();

  const tryEmit = (event: XhrCapturedEvent): void => {
    try {
      emit(event);
    } catch {
      // Capture failure must never break the page's XHR call.
    }
  };

  const emitTerminal = (
    xhr: XMLHttpRequest,
    phase: 'response' | 'error',
  ): void => {
    const state = states.get(xhr);
    if (state === undefined) return;
    const endTs = now();
    if (phase === 'response') {
      const body = readResponseBody(xhr, maxBytes);
      tryEmit(
        Object.freeze({
          kind: 'xhr',
          ts: endTs,
          frameUrl: frame.frameUrl,
          frameKey: frame.frameKey,
          phase: 'response',
          captureId: state.captureId,
          ...(state.method === undefined ? {} : { method: state.method }),
          ...(state.url === undefined ? {} : { url: state.url }),
          status: xhr.status,
          responseType: xhr.responseType,
          ...(body === undefined ? {} : { body }),
          durationMs: endTs - state.startTs,
        }) as XhrCapturedEvent,
      );
      return;
    }
    tryEmit(
      Object.freeze({
        kind: 'xhr',
        ts: endTs,
        frameUrl: frame.frameUrl,
        frameKey: frame.frameKey,
        phase: 'error',
        captureId: state.captureId,
        ...(state.method === undefined ? {} : { method: state.method }),
        ...(state.url === undefined ? {} : { url: state.url }),
        durationMs: endTs - state.startTs,
      }) as XhrCapturedEvent,
    );
  };

  const Wrapped = new Proxy(Original, {
    construct(target, args, newTarget) {
      const xhr = Reflect.construct(
        target,
        args,
        newTarget,
      ) as XMLHttpRequest;
      const state: InstanceState = {
        captureId: idGen(),
        method: undefined,
        url: undefined,
        headers: {},
        startTs: 0,
      };
      states.set(xhr, state);

      const origOpen = xhr.open;
      xhr.open = function patchedOpen(
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ): void {
        const s = states.get(this);
        if (s !== undefined) {
          s.method = method;
          s.url = typeof url === 'string' ? url : url.toString();
        }
        return (origOpen as (...a: unknown[]) => void).call(
          this,
          method,
          url,
          ...rest,
        );
      } as XMLHttpRequest['open'];

      const origSetHeader = xhr.setRequestHeader;
      xhr.setRequestHeader = function patchedSetHeader(
        this: XMLHttpRequest,
        name: string,
        value: string,
      ): void {
        const s = states.get(this);
        if (s !== undefined) s.headers[name] = value;
        return origSetHeader.call(this, name, value);
      } as XMLHttpRequest['setRequestHeader'];

      const origSend = xhr.send;
      xhr.send = function patchedSend(
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ): void {
        const s = states.get(this);
        if (s !== undefined) {
          s.startTs = now();
          let serialized: unknown;
          try {
            serialized = serializeRequestBody(body, maxBytes);
          } catch {
            serialized = undefined;
          }
          tryEmit(
            Object.freeze({
              kind: 'xhr',
              ts: s.startTs,
              frameUrl: frame.frameUrl,
              frameKey: frame.frameKey,
              phase: 'request',
              captureId: s.captureId,
              ...(s.method === undefined ? {} : { method: s.method }),
              ...(s.url === undefined ? {} : { url: s.url }),
              ...(Object.keys(s.headers).length > 0
                ? { headers: { ...s.headers } }
                : {}),
              ...(serialized === undefined ? {} : { body: serialized }),
            }) as XhrCapturedEvent,
          );
        }
        return (origSend as (this: XMLHttpRequest, body?: unknown) => void).call(
          this,
          body,
        );
      } as XMLHttpRequest['send'];

      xhr.addEventListener('load', () => {
        emitTerminal(xhr, 'response');
      });
      xhr.addEventListener('error', () => {
        emitTerminal(xhr, 'error');
      });
      xhr.addEventListener('abort', () => {
        emitTerminal(xhr, 'error');
      });
      xhr.addEventListener('timeout', () => {
        emitTerminal(xhr, 'error');
      });

      return xhr;
    },
  });

  globalThis.XMLHttpRequest = Wrapped as typeof XMLHttpRequest;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    globalThis.XMLHttpRequest = Original;
  };
};
