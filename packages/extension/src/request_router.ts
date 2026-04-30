import { dispatchToTab } from './sw_tab_dispatch/sw_tab_dispatch.js';
import type { SessionPingPayload } from './page_bridge/page_dispatch.js';
import type {
  EventSink,
  GetRecentFilter,
  GetRecentResult,
} from './sw_event_sink/sw_event_sink.js';

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
  readonly pageWorldError?: string;
};

const fetchPageWorld = async (
  tabId: number,
): Promise<{ pageWorld: SessionPingPayload | null; pageWorldError?: string }> => {
  try {
    const response = await dispatchToTab(tabId, { tool: 'session_ping' });
    if (response.error) {
      return { pageWorld: null, pageWorldError: response.error.message };
    }
    return { pageWorld: response.payload as SessionPingPayload };
  } catch (err) {
    return { pageWorld: null, pageWorldError: (err as Error).message };
  }
};

const handleSessionPing: RequestHandler = async () => {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const attachedTabId = tabs[0]?.id ?? null;
  const extensionVersion = chrome.runtime.getManifest().version;
  const pageWorldResult =
    attachedTabId !== null
      ? await fetchPageWorld(attachedTabId)
      : { pageWorld: null, pageWorldError: 'no active tab' };
  const result: SessionPingResult = {
    extensionVersion,
    attachedTabId,
    pageWorld: pageWorldResult.pageWorld,
    ...(pageWorldResult.pageWorldError !== undefined
      ? { pageWorldError: pageWorldResult.pageWorldError }
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

const HANDLERS: Readonly<Record<string, RequestHandler>> = Object.freeze({
  session_ping: handleSessionPing,
  recent_events: handleRecentEvents,
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
