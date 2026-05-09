import {
  encodeResponse,
  type PageBridgeRequestEnvelope,
  type PageBridgeResponseEnvelope,
} from './protocol.js';
import { serializeArgs } from '../captures/serialize.js';

export type SessionPingPayload = {
  readonly url: string;
  readonly title: string;
  readonly readyState: DocumentReadyState;
};

export type EvaluateInput = {
  readonly expression: string;
  readonly timeout_ms?: number;
  readonly await_promise?: boolean;
};

export type EvaluateOutput = {
  readonly value?: unknown;
  readonly truncated?: boolean;
  readonly durationMs: number;
  readonly error?: { readonly message: string; readonly stack?: string };
};

const DEFAULT_EVAL_TIMEOUT_MS = 3000;

export type PageWorldHandler = (
  env: PageBridgeRequestEnvelope,
) => unknown | Promise<unknown>;

export const sessionPingHandler = (): SessionPingPayload =>
  Object.freeze({
    url: window.location.href,
    title: document.title,
    readyState: document.readyState,
  });

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null &&
  (typeof v === 'object' || typeof v === 'function') &&
  typeof (v as { then?: unknown }).then === 'function';

const errorPayload = (
  err: unknown,
): { readonly message: string; readonly stack?: string } => {
  if (err instanceof Error) {
    return err.stack === undefined
      ? Object.freeze({ message: err.message })
      : Object.freeze({ message: err.message, stack: err.stack });
  }
  return Object.freeze({ message: String(err) });
};

const serializeOne = (
  value: unknown,
): { readonly value: unknown; readonly truncated: boolean } => {
  const result = serializeArgs([value]);
  return { value: result.serialized[0], truncated: result.truncated };
};

const readEvaluateInput = (raw: unknown): EvaluateInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['expression'] !== 'string' || r['expression'].length === 0) {
    return null;
  }
  return Object.freeze({
    expression: r['expression'],
    ...(typeof r['timeout_ms'] === 'number' && r['timeout_ms'] > 0
      ? { timeout_ms: r['timeout_ms'] }
      : {}),
    ...(typeof r['await_promise'] === 'boolean'
      ? { await_promise: r['await_promise'] }
      : {}),
  });
};

export const evaluateHandler = async (
  env: PageBridgeRequestEnvelope,
): Promise<EvaluateOutput> => {
  const startedAt = performance.now();
  const input = readEvaluateInput(env.payload);
  if (input === null) {
    return Object.freeze({
      durationMs: performance.now() - startedAt,
      error: Object.freeze({
        message: 'evaluate: payload must be { expression: non-empty string }',
      }),
    });
  }

  let compiled: () => unknown;
  try {
    compiled = new Function(
      'return (' + input.expression + ')',
    ) as () => unknown;
  } catch (err) {
    return Object.freeze({
      durationMs: performance.now() - startedAt,
      error: errorPayload(err),
    });
  }

  let raw: unknown;
  try {
    raw = compiled();
  } catch (err) {
    return Object.freeze({
      durationMs: performance.now() - startedAt,
      error: errorPayload(err),
    });
  }

  if (input.await_promise === true && isThenable(raw)) {
    const timeoutMs = input.timeout_ms ?? DEFAULT_EVAL_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('evaluate-timeout');
    const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
    });
    try {
      const settled = await Promise.race([
        Promise.resolve(raw),
        timeoutPromise,
      ]);
      if (settled === timedOut) {
        return Object.freeze({
          durationMs: performance.now() - startedAt,
          error: Object.freeze({
            message: `evaluate: timeout after ${timeoutMs}ms`,
          }),
        });
      }
      const ser = serializeOne(settled);
      return Object.freeze({
        value: ser.value,
        ...(ser.truncated ? { truncated: true } : {}),
        durationMs: performance.now() - startedAt,
      });
    } catch (err) {
      return Object.freeze({
        durationMs: performance.now() - startedAt,
        error: errorPayload(err),
      });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  const ser = serializeOne(raw);
  return Object.freeze({
    value: ser.value,
    ...(ser.truncated ? { truncated: true } : {}),
    durationMs: performance.now() - startedAt,
  });
};

const HANDLERS: Readonly<Record<string, PageWorldHandler>> = Object.freeze({
  session_ping: () => sessionPingHandler(),
  evaluate: (env) => evaluateHandler(env),
});

export const dispatchPageRequest = async (
  req: PageBridgeRequestEnvelope,
): Promise<PageBridgeResponseEnvelope> => {
  const handler = HANDLERS[req.tool];
  if (!handler) {
    return encodeResponse({
      requestId: req.requestId,
      error: { message: `unknown tool: ${req.tool}` },
    });
  }
  try {
    const payload = await handler(req);
    return encodeResponse({ requestId: req.requestId, payload });
  } catch (err) {
    return encodeResponse({
      requestId: req.requestId,
      error: { message: (err as Error).message },
    });
  }
};
