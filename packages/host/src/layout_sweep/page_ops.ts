import { randomUUID } from 'node:crypto';
import type { LayoutMeasureRequest, LayoutMeasureResult } from '@pwa-debug/shared';
import type { IpcRequestEnvelope, IpcResponseEnvelope } from '../mcp/ipc/envelope.js';
import type { TransportRouter } from '../transport/types.js';

/** One tool call over the connection's normal request path. */
export type ConnectionRequest = (
  tool: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
) => Promise<IpcResponseEnvelope>;

/** Page work the sweep does through the connection (extension bridge or phone CDP session). */
export type PageOps = {
  readonly navigate: (url: string) => Promise<void>;
  /** Evaluate an expression in the page's main world; throws with the page's message on failure. */
  readonly evaluate: (expression: string, awaitPromise?: boolean) => Promise<unknown>;
  readonly measure: (req: LayoutMeasureRequest) => Promise<LayoutMeasureResult>;
  readonly freeze: () => Promise<void>;
  readonly ping: () => Promise<boolean>;
};

const NAV_TIMEOUT_MS = 12_000;
const EVAL_TIMEOUT_MS = 3_000;
const IPC_SLACK_MS = 2_000;

/** Bind the router to one connection (and optional tab) as a ConnectionRequest. */
export const connectionRequest = (
  router: TransportRouter,
  connectionId: string,
): ConnectionRequest => (tool, payload, timeoutMs) => {
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool,
    extensionId: connectionId,
    payload,
  });
  return router.request(connectionId, env, { timeoutMs });
};

const unwrap = (r: IpcResponseEnvelope, what: string): unknown => {
  if (r.error !== undefined) throw new Error(`${what}: ${r.error.message}`);
  return r.payload;
};

const pageError = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const e = (payload as { error?: { message?: unknown } }).error;
  return e !== undefined && typeof e.message === 'string' ? e.message : null;
};

/**
 * PageOps over a connection. tab_id is passed only for extension connections
 * (CDP sessions are one page each and ignore it).
 */
export const createPageOps = (request: ConnectionRequest, tabId?: number): PageOps => {
  const withTab = (p: Record<string, unknown>): Record<string, unknown> =>
    tabId !== undefined ? { ...p, tab_id: tabId } : p;

  const evaluate = async (expression: string, awaitPromise = false): Promise<unknown> => {
    const payload = unwrap(
      await request(
        'evaluate',
        withTab({ expression, timeout_ms: EVAL_TIMEOUT_MS, ...(awaitPromise ? { await_promise: true } : {}) }),
        EVAL_TIMEOUT_MS + IPC_SLACK_MS,
      ),
      'evaluate',
    );
    const err = pageError(payload);
    if (err !== null) throw new Error(`page expression failed: ${err}`);
    return (payload as { value?: unknown } | undefined)?.value;
  };

  const layoutMeasure = async (req: LayoutMeasureRequest): Promise<unknown> => {
    const payload = unwrap(
      await request('layout_measure', withTab({ ...req }), EVAL_TIMEOUT_MS + IPC_SLACK_MS),
      'layout_measure',
    );
    const err = pageError(payload);
    if (err !== null) throw new Error(err);
    return payload;
  };

  return Object.freeze({
    navigate: async (url: string) => {
      unwrap(await request('pdl_navigate', withTab({ url, timeout_ms: 10_000 }), NAV_TIMEOUT_MS + IPC_SLACK_MS), 'navigate');
    },
    evaluate,
    measure: async (req) => (await layoutMeasure(req)) as LayoutMeasureResult,
    freeze: async () => {
      await layoutMeasure({ op: 'freeze' });
    },
    ping: async () => {
      try {
        const r = await request('session_ping', withTab({}), 2_000);
        return r.error === undefined;
      } catch {
        return false;
      }
    },
  });
};

/** True for the router's "connection is gone" failure. */
export const isConnectionGone = (err: unknown): boolean =>
  err instanceof Error && /no connected NMH for/.test(err.message);
