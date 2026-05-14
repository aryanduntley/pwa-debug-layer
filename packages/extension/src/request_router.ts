import {
  dispatchToTab,
  dispatchToActiveTab,
  dispatchToTabClassified,
} from './sw_tab_dispatch/sw_tab_dispatch.js';
import type { SessionPingPayload } from './page_bridge/page_dispatch.js';
import type {
  EventSink,
  GetRecentFilter,
  GetRecentResult,
} from './sw_event_sink/sw_event_sink.js';
import type { PageWorldErrorCode } from './sw_health_probe/sw_health_probe.js';

export type SwRequestEnvelope = {
  readonly type: 'request';
  readonly requestId: string;
  readonly tool: string;
  readonly extensionId?: string;
  readonly payload?: unknown;
};

export type SwResponseEnvelope = {
  readonly type: 'response';
  readonly requestId: string;
  readonly payload?: unknown;
  readonly error?: { readonly message: string };
};

export type RouterContext = {
  readonly sink: EventSink;
};

type RequestHandler = (
  env: SwRequestEnvelope,
  ctx: RouterContext,
) => Promise<unknown>;

export const isSwRequestEnvelope = (m: unknown): m is SwRequestEnvelope => {
  if (m === null || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return (
    r['type'] === 'request' &&
    typeof r['requestId'] === 'string' &&
    typeof r['tool'] === 'string'
  );
};

type SessionPingResult = {
  readonly extensionVersion: string;
  readonly attachedTabId: number | null;
  readonly pageWorld: SessionPingPayload | null;
  readonly pageWorldError?: PageWorldErrorCode;
  readonly pageWorldErrorMessage?: string;
  readonly pageWorldSelfHealed?: boolean;
};

type FetchPageWorldResult = {
  readonly pageWorld: SessionPingPayload | null;
  readonly pageWorldError?: PageWorldErrorCode;
  readonly pageWorldErrorMessage?: string;
  readonly pageWorldSelfHealed?: boolean;
};

const fetchPageWorld = async (tabId: number): Promise<FetchPageWorldResult> => {
  const result = await dispatchToTabClassified(tabId, { tool: 'session_ping' });
  if (result.ok) {
    const payload = result.response.payload as SessionPingPayload | undefined;
    return {
      pageWorld: payload ?? null,
      ...(result.selfHealed ? { pageWorldSelfHealed: true } : {}),
    };
  }
  return {
    pageWorld: null,
    pageWorldError: result.code,
    pageWorldErrorMessage: result.message,
    ...(result.selfHealed ? { pageWorldSelfHealed: true } : {}),
  };
};

const handleSessionPing: RequestHandler = async () => {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const attachedTabId = tabs[0]?.id ?? null;
  const extensionVersion = chrome.runtime.getManifest().version;
  const pageWorldResult: FetchPageWorldResult =
    attachedTabId !== null
      ? await fetchPageWorld(attachedTabId)
      : {
          pageWorld: null,
          pageWorldError: 'no_active_tab',
          pageWorldErrorMessage: 'no active tab',
        };
  const result: SessionPingResult = {
    extensionVersion,
    attachedTabId,
    pageWorld: pageWorldResult.pageWorld,
    ...(pageWorldResult.pageWorldError !== undefined
      ? { pageWorldError: pageWorldResult.pageWorldError }
      : {}),
    ...(pageWorldResult.pageWorldErrorMessage !== undefined
      ? { pageWorldErrorMessage: pageWorldResult.pageWorldErrorMessage }
      : {}),
    ...(pageWorldResult.pageWorldSelfHealed
      ? { pageWorldSelfHealed: true }
      : {}),
  };
  return result;
};

const sanitizeRecentFilter = (raw: unknown): GetRecentFilter => {
  if (raw === null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const kinds = Array.isArray(r['kinds'])
    ? (r['kinds'] as unknown[]).filter((k): k is string => typeof k === 'string')
    : undefined;
  const sinceMs = typeof r['sinceMs'] === 'number' ? r['sinceMs'] : undefined;
  const limit = typeof r['limit'] === 'number' ? r['limit'] : undefined;
  return {
    ...(kinds !== undefined ? { kinds } : {}),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
};

const handleRecentEvents: RequestHandler = async (env, ctx) => {
  const filter = sanitizeRecentFilter(env.payload);
  const result: GetRecentResult = ctx.sink.getRecent(filter);
  return result;
};

type EvaluateRouted = {
  readonly tabId: number | undefined;
  readonly payload: {
    readonly expression: string;
    readonly timeout_ms?: number;
    readonly await_promise?: boolean;
  };
};

const sanitizeEvaluateInput = (raw: unknown): EvaluateRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const expression = r['expression'];
  if (typeof expression !== 'string' || expression.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  return {
    tabId,
    payload: {
      expression,
      ...(typeof r['timeout_ms'] === 'number' && r['timeout_ms'] > 0
        ? { timeout_ms: r['timeout_ms'] as number }
        : {}),
      ...(typeof r['await_promise'] === 'boolean'
        ? { await_promise: r['await_promise'] as boolean }
        : {}),
    },
  };
};

const handleEvaluate: RequestHandler = async (env) => {
  const sanitized = sanitizeEvaluateInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'evaluate: payload must be { expression: non-empty string, tab_id?, timeout_ms?, await_promise? }',
    );
  }
  const csReq = { tool: 'evaluate', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type ReactTreeRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeReactTreeInput = (raw: unknown): ReactTreeRouted | null => {
  if (raw === undefined || raw === null) {
    return { tabId: undefined, payload: {} };
  }
  if (typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = {};
  if (
    typeof r['root_index'] === 'number' &&
    Number.isInteger(r['root_index']) &&
    (r['root_index'] as number) >= 0
  ) {
    payload['root_index'] = r['root_index'];
  }
  if (
    typeof r['depth_limit'] === 'number' &&
    Number.isInteger(r['depth_limit']) &&
    (r['depth_limit'] as number) > 0
  ) {
    payload['depth_limit'] = r['depth_limit'];
  }
  if (
    typeof r['max_nodes'] === 'number' &&
    Number.isInteger(r['max_nodes']) &&
    (r['max_nodes'] as number) > 0
  ) {
    payload['max_nodes'] = r['max_nodes'];
  }
  return { tabId, payload };
};

const handleReactTree: RequestHandler = async (env) => {
  const sanitized = sanitizeReactTreeInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'react_tree: payload must be an object with optional { tab_id?, root_index?, depth_limit?, max_nodes? }',
    );
  }
  const csReq = { tool: 'react_tree', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type ReactGetStateRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeReactGetStateInput = (raw: unknown): ReactGetStateRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stableId = r['stable_id'];
  if (typeof stableId !== 'string' || stableId.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { stable_id: stableId };
  if (
    typeof r['root_index'] === 'number' &&
    Number.isInteger(r['root_index']) &&
    (r['root_index'] as number) >= 0
  ) {
    payload['root_index'] = r['root_index'];
  }
  if (typeof r['include_props'] === 'boolean') payload['include_props'] = r['include_props'];
  if (typeof r['include_hooks'] === 'boolean') payload['include_hooks'] = r['include_hooks'];
  return { tabId, payload };
};

const handleReactGetState: RequestHandler = async (env) => {
  const sanitized = sanitizeReactGetStateInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'react_get_state: payload must be { stable_id: non-empty string, tab_id?, root_index?, include_props?, include_hooks? }',
    );
  }
  const csReq = { tool: 'react_get_state', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

const HANDLERS: Readonly<Record<string, RequestHandler>> = Object.freeze({
  session_ping: handleSessionPing,
  recent_events: handleRecentEvents,
  evaluate: handleEvaluate,
  react_tree: handleReactTree,
  react_get_state: handleReactGetState,
});

const errorResponse = (
  requestId: string,
  message: string,
): SwResponseEnvelope =>
  Object.freeze({
    type: 'response',
    requestId,
    error: Object.freeze({ message }),
  });

const okResponse = (
  requestId: string,
  payload: unknown,
): SwResponseEnvelope =>
  Object.freeze({
    type: 'response',
    requestId,
    payload,
  });

export const routeRequest = async (
  env: SwRequestEnvelope,
  ctx: RouterContext,
): Promise<SwResponseEnvelope> => {
  const handler = HANDLERS[env.tool];
  if (!handler) {
    return errorResponse(env.requestId, `unknown tool: ${env.tool}`);
  }
  try {
    const payload = await handler(env, ctx);
    return okResponse(env.requestId, payload);
  } catch (err) {
    return errorResponse(env.requestId, (err as Error).message);
  }
};
