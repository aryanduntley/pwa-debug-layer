import { serializeArgs } from './serialize.js';
import type { Disposer, FrameMeta } from './capture_console.js';
import type { FetchCapturedEvent } from './types.js';

export type FetchCaptureOptions = {
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly idGen?: () => string;
  readonly responseBodyTimeoutMs?: number;
};

const DEFAULT_RESPONSE_BODY_TIMEOUT_MS = 1000;

const defaultIdGen = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const headersToRecord = (
  source: HeadersInit | Headers | undefined,
): Record<string, string> | undefined => {
  if (source === undefined) return undefined;
  const out: Record<string, string> = {};
  if (typeof Headers !== 'undefined' && source instanceof Headers) {
    source.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(source)) {
    for (const pair of source) {
      if (Array.isArray(pair) && pair.length >= 2) {
        out[String(pair[0])] = String(pair[1]);
      }
    }
    return out;
  }
  if (typeof source === 'object') {
    for (const [k, v] of Object.entries(source as Record<string, string>)) {
      out[k] = String(v);
    }
    return out;
  }
  return undefined;
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
  body: BodyInit | null | undefined,
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
  if (ArrayBuffer.isView(body)) return tagArrayBuffer(body.buffer);
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return tagStream();
  }
  return tagStream();
};

const readResponseBody = async (
  response: Response,
  timeoutMs: number,
  maxBytes: number | undefined,
): Promise<unknown> => {
  let cloned: Response;
  try {
    cloned = response.clone();
  } catch {
    return tagStream();
  }
  const text = cloned.text();
  const timer = new Promise<typeof TIMEOUT>((resolve) => {
    setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  let result: string | typeof TIMEOUT;
  try {
    result = await Promise.race([text, timer]);
  } catch {
    return tagStream();
  }
  if (result === TIMEOUT) return tagStream();
  const opts = maxBytes === undefined ? undefined : { maxBytes };
  return serializeArgs([result], opts).serialized[0];
};

const TIMEOUT = Symbol('timeout');

type RequestParts = {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
  readonly body: BodyInit | null | undefined;
};

const resolveRequestParts = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): RequestParts => {
  if (typeof input === 'string') {
    return {
      method: init?.method ?? 'GET',
      url: input,
      headers: headersToRecord(init?.headers),
      body: init?.body,
    };
  }
  if (typeof URL !== 'undefined' && input instanceof URL) {
    return {
      method: init?.method ?? 'GET',
      url: input.toString(),
      headers: headersToRecord(init?.headers),
      body: init?.body,
    };
  }
  const req = input as Request;
  return {
    method: init?.method ?? req.method ?? 'GET',
    url: req.url ?? '',
    headers: headersToRecord(init?.headers ?? req.headers),
    body: init?.body,
  };
};

const responseHeadersToRecord = (response: Response): Record<string, string> => {
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
};

export const installFetchCapture = (
  emit: (event: FetchCapturedEvent) => void,
  frame: FrameMeta,
  opts?: FetchCaptureOptions,
): Disposer => {
  const original = globalThis.fetch;
  if (typeof original !== 'function') {
    return () => {};
  }
  const now = opts?.now ?? (() => Date.now());
  const idGen = opts?.idGen ?? defaultIdGen;
  const maxBytes = opts?.maxBytes;
  const responseBodyTimeoutMs =
    opts?.responseBodyTimeoutMs ?? DEFAULT_RESPONSE_BODY_TIMEOUT_MS;

  const tryEmit = (event: FetchCapturedEvent): void => {
    try {
      emit(event);
    } catch {
      // Capture failure must never break the page's fetch call.
    }
  };

  const wrapped = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const captureId = idGen();
    const startTs = now();
    const parts = resolveRequestParts(input, init);

    let requestBody: unknown;
    try {
      requestBody = serializeRequestBody(parts.body, maxBytes);
    } catch {
      requestBody = undefined;
    }

    tryEmit(
      Object.freeze({
        kind: 'fetch',
        ts: startTs,
        frameUrl: frame.frameUrl,
        frameKey: frame.frameKey,
        phase: 'request',
        captureId,
        method: parts.method,
        url: parts.url,
        ...(parts.headers === undefined ? {} : { headers: parts.headers }),
        ...(requestBody === undefined ? {} : { body: requestBody }),
      }) as FetchCapturedEvent,
    );

    try {
      const response = await original.call(globalThis, input, init);
      const endTs = now();
      let responseBody: unknown;
      try {
        responseBody = await readResponseBody(
          response,
          responseBodyTimeoutMs,
          maxBytes,
        );
      } catch {
        responseBody = undefined;
      }
      tryEmit(
        Object.freeze({
          kind: 'fetch',
          ts: endTs,
          frameUrl: frame.frameUrl,
          frameKey: frame.frameKey,
          phase: 'response',
          captureId,
          method: parts.method,
          url: parts.url,
          status: response.status,
          headers: responseHeadersToRecord(response),
          ...(responseBody === undefined ? {} : { body: responseBody }),
          durationMs: endTs - startTs,
        }) as FetchCapturedEvent,
      );
      return response;
    } catch (err) {
      const endTs = now();
      const opts = maxBytes === undefined ? undefined : { maxBytes };
      const serializedErr = serializeArgs([err], opts).serialized[0];
      tryEmit(
        Object.freeze({
          kind: 'fetch',
          ts: endTs,
          frameUrl: frame.frameUrl,
          frameKey: frame.frameKey,
          phase: 'error',
          captureId,
          method: parts.method,
          url: parts.url,
          body: serializedErr,
          durationMs: endTs - startTs,
        }) as FetchCapturedEvent,
      );
      throw err;
    }
  };

  globalThis.fetch = wrapped as typeof globalThis.fetch;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    globalThis.fetch = original;
  };
};
