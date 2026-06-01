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
import { ACTION_TOOL_SPECS } from '@pwa-debug/shared';

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

type ReactFindByTextRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeReactFindByTextInput = (
  raw: unknown,
): ReactFindByTextRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pattern = r['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { pattern };
  if (typeof r['exact'] === 'boolean') payload['exact'] = r['exact'];
  if (
    typeof r['root_index'] === 'number' &&
    Number.isInteger(r['root_index']) &&
    (r['root_index'] as number) >= 0
  ) {
    payload['root_index'] = r['root_index'];
  }
  if (
    typeof r['max_matches'] === 'number' &&
    Number.isInteger(r['max_matches']) &&
    (r['max_matches'] as number) > 0
  ) {
    payload['max_matches'] = r['max_matches'];
  }
  return { tabId, payload };
};

const handleReactFindByText: RequestHandler = async (env) => {
  const sanitized = sanitizeReactFindByTextInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'react_find_by_text: payload must be { pattern: non-empty string, tab_id?, exact?, root_index?, max_matches? }',
    );
  }
  const csReq = { tool: 'react_find_by_text', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type ReactFindByRoleRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeReactFindByRoleInput = (
  raw: unknown,
): ReactFindByRoleRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const role = r['role'];
  if (typeof role !== 'string' || role.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { role };
  if (typeof r['name'] === 'string' && r['name'].length > 0) {
    payload['name'] = r['name'];
  }
  if (
    typeof r['root_index'] === 'number' &&
    Number.isInteger(r['root_index']) &&
    (r['root_index'] as number) >= 0
  ) {
    payload['root_index'] = r['root_index'];
  }
  if (
    typeof r['max_matches'] === 'number' &&
    Number.isInteger(r['max_matches']) &&
    (r['max_matches'] as number) > 0
  ) {
    payload['max_matches'] = r['max_matches'];
  }
  return { tabId, payload };
};

const handleReactFindByRole: RequestHandler = async (env) => {
  const sanitized = sanitizeReactFindByRoleInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'react_find_by_role: payload must be { role: non-empty string, tab_id?, name?, root_index?, max_matches? }',
    );
  }
  const csReq = { tool: 'react_find_by_role', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

// ── Vue introspection (Path 5 M39) — parity with react_tree/react_get_state ──

type VueTreeRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeVueTreeInput = (raw: unknown): VueTreeRouted | null => {
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

const handleVueTree: RequestHandler = async (env) => {
  const sanitized = sanitizeVueTreeInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'vue_tree: payload must be an object with optional { tab_id?, root_index?, depth_limit?, max_nodes? }',
    );
  }
  const csReq = { tool: 'vue_tree', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type VueGetStateRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeVueGetStateInput = (raw: unknown): VueGetStateRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stableId = r['stable_id'];
  if (typeof stableId !== 'string' || stableId.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { stable_id: stableId };
  if (typeof r['include_props'] === 'boolean') payload['include_props'] = r['include_props'];
  if (typeof r['include_state'] === 'boolean') payload['include_state'] = r['include_state'];
  return { tabId, payload };
};

const handleVueGetState: RequestHandler = async (env) => {
  const sanitized = sanitizeVueGetStateInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'vue_get_state: payload must be { stable_id: non-empty string, tab_id?, include_props?, include_state? }',
    );
  }
  const csReq = { tool: 'vue_get_state', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type VueFindByTextRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeVueFindByTextInput = (
  raw: unknown,
): VueFindByTextRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pattern = r['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { pattern };
  if (typeof r['exact'] === 'boolean') payload['exact'] = r['exact'];
  if (
    typeof r['root_index'] === 'number' &&
    Number.isInteger(r['root_index']) &&
    (r['root_index'] as number) >= 0
  ) {
    payload['root_index'] = r['root_index'];
  }
  if (
    typeof r['max_matches'] === 'number' &&
    Number.isInteger(r['max_matches']) &&
    (r['max_matches'] as number) > 0
  ) {
    payload['max_matches'] = r['max_matches'];
  }
  return { tabId, payload };
};

const handleVueFindByText: RequestHandler = async (env) => {
  const sanitized = sanitizeVueFindByTextInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'vue_find_by_text: payload must be { pattern: non-empty string, tab_id?, exact?, root_index?, max_matches? }',
    );
  }
  const csReq = { tool: 'vue_find_by_text', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type VueFindByRoleRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeVueFindByRoleInput = (
  raw: unknown,
): VueFindByRoleRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const role = r['role'];
  if (typeof role !== 'string' || role.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { role };
  if (typeof r['name'] === 'string' && r['name'].length > 0) {
    payload['name'] = r['name'];
  }
  if (
    typeof r['root_index'] === 'number' &&
    Number.isInteger(r['root_index']) &&
    (r['root_index'] as number) >= 0
  ) {
    payload['root_index'] = r['root_index'];
  }
  if (
    typeof r['max_matches'] === 'number' &&
    Number.isInteger(r['max_matches']) &&
    (r['max_matches'] as number) > 0
  ) {
    payload['max_matches'] = r['max_matches'];
  }
  return { tabId, payload };
};

const handleVueFindByRole: RequestHandler = async (env) => {
  const sanitized = sanitizeVueFindByRoleInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'vue_find_by_role: payload must be { role: non-empty string, tab_id?, name?, root_index?, max_matches? }',
    );
  }
  const csReq = { tool: 'vue_find_by_role', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

// ── Svelte introspection (Path 5 M42) ───────────────────────────────────────

const handleSvelteComponents: RequestHandler = async (env) => {
  const raw = env.payload;
  const tabId =
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as Record<string, unknown>)['tab_id'] === 'number' &&
    Number.isFinite((raw as Record<string, unknown>)['tab_id'])
      ? ((raw as Record<string, unknown>)['tab_id'] as number)
      : undefined;
  const csReq = { tool: 'svelte_components', payload: {} };
  const response =
    tabId !== undefined
      ? await dispatchToTab(tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

// sw_status (PWA Runtime Diagnostics): forward to the active (or given) tab's
// page-world, which reads navigator.serviceWorker. No params beyond tab_id —
// same shape as svelte_components.
const handleSwStatus: RequestHandler = async (env) => {
  const raw = env.payload;
  const tabId =
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as Record<string, unknown>)['tab_id'] === 'number' &&
    Number.isFinite((raw as Record<string, unknown>)['tab_id'])
      ? ((raw as Record<string, unknown>)['tab_id'] as number)
      : undefined;
  const csReq = { tool: 'sw_status', payload: {} };
  const response =
    tabId !== undefined
      ? await dispatchToTab(tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

// cache_* (PWA Runtime Diagnostics): forward to the active/given tab's page-world.
const readTabId = (raw: unknown): number | undefined =>
  raw !== null &&
  typeof raw === 'object' &&
  typeof (raw as Record<string, unknown>)['tab_id'] === 'number' &&
  Number.isFinite((raw as Record<string, unknown>)['tab_id'])
    ? ((raw as Record<string, unknown>)['tab_id'] as number)
    : undefined;

const handleCacheList: RequestHandler = async (env) => {
  const tabId = readTabId(env.payload);
  const csReq = { tool: 'cache_list', payload: {} };
  const response =
    tabId !== undefined
      ? await dispatchToTab(tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) throw new Error(response.error.message);
  return response.payload;
};

const handleCacheInspect: RequestHandler = async (env) => {
  const r =
    env.payload !== null && typeof env.payload === 'object'
      ? (env.payload as Record<string, unknown>)
      : {};
  const name = r['cache_name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('cache_inspect: payload must include { cache_name: non-empty string }');
  }
  const payload: Record<string, unknown> = { cache_name: name };
  if (typeof r['limit'] === 'number' && Number.isInteger(r['limit']) && (r['limit'] as number) > 0) {
    payload['limit'] = r['limit'];
  }
  const tabId = readTabId(env.payload);
  const csReq = { tool: 'cache_inspect', payload };
  const response =
    tabId !== undefined
      ? await dispatchToTab(tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) throw new Error(response.error.message);
  return response.payload;
};

const handleCacheMatch: RequestHandler = async (env) => {
  const r =
    env.payload !== null && typeof env.payload === 'object'
      ? (env.payload as Record<string, unknown>)
      : {};
  const url = r['url'];
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('cache_match: payload must include { url: non-empty string }');
  }
  const tabId = readTabId(env.payload);
  const csReq = { tool: 'cache_match', payload: { url } };
  const response =
    tabId !== undefined
      ? await dispatchToTab(tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) throw new Error(response.error.message);
  return response.payload;
};

type SvelteFindRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeSvelteFindByTextInput = (raw: unknown): SvelteFindRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pattern = r['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { pattern };
  if (typeof r['exact'] === 'boolean') payload['exact'] = r['exact'];
  if (
    typeof r['max_matches'] === 'number' &&
    Number.isInteger(r['max_matches']) &&
    (r['max_matches'] as number) > 0
  ) {
    payload['max_matches'] = r['max_matches'];
  }
  return { tabId, payload };
};

const handleSvelteFindByText: RequestHandler = async (env) => {
  const sanitized = sanitizeSvelteFindByTextInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'svelte_find_by_text: payload must be { pattern: non-empty string, tab_id?, exact?, max_matches? }',
    );
  }
  const csReq = { tool: 'svelte_find_by_text', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

const sanitizeSvelteFindByRoleInput = (raw: unknown): SvelteFindRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const role = r['role'];
  if (typeof role !== 'string' || role.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { role };
  if (typeof r['name'] === 'string' && (r['name'] as string).length > 0) {
    payload['name'] = r['name'];
  }
  if (
    typeof r['max_matches'] === 'number' &&
    Number.isInteger(r['max_matches']) &&
    (r['max_matches'] as number) > 0
  ) {
    payload['max_matches'] = r['max_matches'];
  }
  return { tabId, payload };
};

const handleSvelteFindByRole: RequestHandler = async (env) => {
  const sanitized = sanitizeSvelteFindByRoleInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'svelte_find_by_role: payload must be { role: non-empty string, tab_id?, name?, max_matches? }',
    );
  }
  const csReq = { tool: 'svelte_find_by_role', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

// ── Solid introspection (Path 5 M43) ────────────────────────────────────────

const handleSolidDetect: RequestHandler = async (env) => {
  const raw = env.payload;
  const tabId =
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as Record<string, unknown>)['tab_id'] === 'number' &&
    Number.isFinite((raw as Record<string, unknown>)['tab_id'])
      ? ((raw as Record<string, unknown>)['tab_id'] as number)
      : undefined;
  const csReq = { tool: 'solid_detect', payload: {} };
  const response =
    tabId !== undefined
      ? await dispatchToTab(tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type SolidFindRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeSolidFindByTextInput = (raw: unknown): SolidFindRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pattern = r['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { pattern };
  if (typeof r['exact'] === 'boolean') payload['exact'] = r['exact'];
  if (
    typeof r['max_matches'] === 'number' &&
    Number.isInteger(r['max_matches']) &&
    (r['max_matches'] as number) > 0
  ) {
    payload['max_matches'] = r['max_matches'];
  }
  return { tabId, payload };
};

const handleSolidFindByText: RequestHandler = async (env) => {
  const sanitized = sanitizeSolidFindByTextInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'solid_find_by_text: payload must be { pattern: non-empty string, tab_id?, exact?, max_matches? }',
    );
  }
  const csReq = { tool: 'solid_find_by_text', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

const sanitizeSolidFindByRoleInput = (raw: unknown): SolidFindRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const role = r['role'];
  if (typeof role !== 'string' || role.length === 0) return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { role };
  if (typeof r['name'] === 'string' && (r['name'] as string).length > 0) {
    payload['name'] = r['name'];
  }
  if (
    typeof r['max_matches'] === 'number' &&
    Number.isInteger(r['max_matches']) &&
    (r['max_matches'] as number) > 0
  ) {
    payload['max_matches'] = r['max_matches'];
  }
  return { tabId, payload };
};

const handleSolidFindByRole: RequestHandler = async (env) => {
  const sanitized = sanitizeSolidFindByRoleInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'solid_find_by_role: payload must be { role: non-empty string, tab_id?, name?, max_matches? }',
    );
  }
  const csReq = { tool: 'solid_find_by_role', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type ReduxGetStateRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeReduxGetStateInput = (
  raw: unknown,
): ReduxGetStateRouted | null => {
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
  if (typeof r['path'] === 'string' && (r['path'] as string).length > 0) {
    payload['path'] = r['path'];
  }
  return { tabId, payload };
};

const handleReduxGetState: RequestHandler = async (env) => {
  const sanitized = sanitizeReduxGetStateInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'redux_get_state: payload must be an object with optional { tab_id?, path? }',
    );
  }
  const csReq = { tool: 'redux_get_state', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type ReduxSubscribeRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeReduxSubscribeInput = (
  raw: unknown,
): ReduxSubscribeRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (action !== 'start' && action !== 'stop') return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { action };
  if (typeof r['path'] === 'string' && (r['path'] as string).length > 0) {
    payload['path'] = r['path'];
  }
  return { tabId, payload };
};

const handleReduxSubscribe: RequestHandler = async (env) => {
  const sanitized = sanitizeReduxSubscribeInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      "redux_subscribe: payload must be { action: 'start' | 'stop', tab_id?, path? }",
    );
  }
  const csReq = { tool: 'redux_subscribe', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type ReduxDispatchRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeReduxDispatchInput = (
  raw: unknown,
): ReduxDispatchRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (action === null || typeof action !== 'object') return null;
  const a = action as Record<string, unknown>;
  if (typeof a['type'] !== 'string' || (a['type'] as string).length === 0) {
    return null;
  }
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  return { tabId, payload: { action } };
};

const handleReduxDispatch: RequestHandler = async (env) => {
  const sanitized = sanitizeReduxDispatchInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'redux_dispatch: payload must be { action: { type: non-empty string; payload? }, tab_id? }',
    );
  }
  const csReq = { tool: 'redux_dispatch', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

// ── Unified store_* family (Path 4 M2) ──────────────────────────────────────
// Framework-aware variants of the redux_* sanitizers: they additionally pass
// an optional `framework` selector through to the page-world store handlers
// (which auto-detect when it is absent) and forward to the store_* page keys.
// The redux_* handlers above are kept untouched as deprecated aliases.

const extractFramework = (r: Record<string, unknown>): string | undefined =>
  typeof r['framework'] === 'string' && (r['framework'] as string).length > 0
    ? (r['framework'] as string)
    : undefined;

type StoreRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const routedTabId = (r: Record<string, unknown>): number | undefined =>
  typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
    ? (r['tab_id'] as number)
    : undefined;

const sanitizeStoreGetStateInput = (raw: unknown): StoreRouted | null => {
  if (raw === undefined || raw === null) {
    return { tabId: undefined, payload: {} };
  }
  if (typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  if (typeof r['path'] === 'string' && (r['path'] as string).length > 0) {
    payload['path'] = r['path'];
  }
  const framework = extractFramework(r);
  if (framework !== undefined) payload['framework'] = framework;
  return { tabId: routedTabId(r), payload };
};

const handleStoreGetState: RequestHandler = async (env) => {
  const sanitized = sanitizeStoreGetStateInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'store_get_state: payload must be an object with optional { tab_id?, path?, framework? }',
    );
  }
  const csReq = { tool: 'store_get_state', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

const sanitizeStoreSubscribeInput = (raw: unknown): StoreRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (action !== 'start' && action !== 'stop') return null;
  const payload: Record<string, unknown> = { action };
  if (typeof r['path'] === 'string' && (r['path'] as string).length > 0) {
    payload['path'] = r['path'];
  }
  const framework = extractFramework(r);
  if (framework !== undefined) payload['framework'] = framework;
  return { tabId: routedTabId(r), payload };
};

const handleStoreSubscribe: RequestHandler = async (env) => {
  const sanitized = sanitizeStoreSubscribeInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      "store_subscribe: payload must be { action: 'start' | 'stop', tab_id?, path?, framework? }",
    );
  }
  const csReq = { tool: 'store_subscribe', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

const sanitizeStoreDispatchInput = (raw: unknown): StoreRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (action === null || typeof action !== 'object') return null;
  const a = action as Record<string, unknown>;
  if (typeof a['type'] !== 'string' || (a['type'] as string).length === 0) {
    return null;
  }
  const payload: Record<string, unknown> = { action };
  const framework = extractFramework(r);
  if (framework !== undefined) payload['framework'] = framework;
  return { tabId: routedTabId(r), payload };
};

const handleStoreDispatch: RequestHandler = async (env) => {
  const sanitized = sanitizeStoreDispatchInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'store_dispatch: payload must be { action: { type: non-empty string; payload? }, tab_id?, framework? }',
    );
  }
  const csReq = { tool: 'store_dispatch', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type SourceMapResolveRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeSourceMapResolveInput = (
  raw: unknown,
): SourceMapResolveRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const scriptUrl = r['script_url'];
  if (typeof scriptUrl !== 'string' || scriptUrl.length === 0) return null;
  const line = r['line'];
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
  const column = r['column'];
  if (typeof column !== 'number' || !Number.isInteger(column) || column < 0) {
    return null;
  }
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  return {
    tabId,
    payload: { script_url: scriptUrl, line, column },
  };
};

const handleSourceMapResolve: RequestHandler = async (env) => {
  const sanitized = sanitizeSourceMapResolveInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      'source_map_resolve: payload must be { script_url, line: int>=1, column: int>=0, tab_id? }',
    );
  }
  const csReq = { tool: 'source_map_resolve', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

type SessionRecordRouted = {
  readonly tabId: number | undefined;
  readonly payload: Record<string, unknown>;
};

const sanitizeSessionRecordInput = (
  raw: unknown,
): SessionRecordRouted | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (action !== 'start' && action !== 'stop') return null;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = { action };
  if (typeof r['session_id'] === 'string' && (r['session_id'] as string).length > 0) {
    payload['session_id'] = r['session_id'];
  }
  if (
    typeof r['duration_cap_ms'] === 'number' &&
    Number.isInteger(r['duration_cap_ms']) &&
    (r['duration_cap_ms'] as number) > 0
  ) {
    payload['duration_cap_ms'] = r['duration_cap_ms'];
  }
  return { tabId, payload };
};

const handleSessionRecord: RequestHandler = async (env) => {
  const sanitized = sanitizeSessionRecordInput(env.payload);
  if (sanitized === null) {
    throw new Error(
      "session_record: payload must be { action: 'start' | 'stop', tab_id?, session_id?, duration_cap_ms? }",
    );
  }
  const csReq = { tool: 'session_record', payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.payload;
};

// --- Path 7 interaction action tools (pdl_*) ---------------------------------
// One generic handler per ACTION_TOOL_SPECS entry: extract tab_id for routing,
// forward the locator + params payload to the page-world unchanged.

const sanitizeActionInput = (
  raw: unknown,
): { tabId?: number; payload: Record<string, unknown> } | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tabId =
    typeof r['tab_id'] === 'number' && Number.isFinite(r['tab_id'])
      ? (r['tab_id'] as number)
      : undefined;
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k !== 'tab_id' && k !== 'extension_id' && v !== undefined) payload[k] = v;
  }
  return tabId !== undefined ? { tabId, payload } : { payload };
};

const makeActionRequestHandler = (tool: string): RequestHandler => async (env) => {
  const sanitized = sanitizeActionInput(env.payload);
  if (sanitized === null) {
    throw new Error(`${tool}: payload must be an object carrying a locator`);
  }
  const csReq = { tool, payload: sanitized.payload };
  const response =
    sanitized.tabId !== undefined
      ? await dispatchToTab(sanitized.tabId, csReq)
      : await dispatchToActiveTab(csReq);
  if (response.error) throw new Error(response.error.message);
  return response.payload;
};

const actionRequestHandlers: Readonly<Record<string, RequestHandler>> = Object.freeze(
  Object.fromEntries(ACTION_TOOL_SPECS.map((s) => [s.tool, makeActionRequestHandler(s.tool)])),
);

const HANDLERS: Readonly<Record<string, RequestHandler>> = Object.freeze({
  ...actionRequestHandlers,
  session_ping: handleSessionPing,
  recent_events: handleRecentEvents,
  evaluate: handleEvaluate,
  react_tree: handleReactTree,
  react_get_state: handleReactGetState,
  react_find_by_text: handleReactFindByText,
  react_find_by_role: handleReactFindByRole,
  vue_tree: handleVueTree,
  vue_get_state: handleVueGetState,
  vue_find_by_text: handleVueFindByText,
  vue_find_by_role: handleVueFindByRole,
  svelte_components: handleSvelteComponents,
  svelte_find_by_text: handleSvelteFindByText,
  svelte_find_by_role: handleSvelteFindByRole,
  solid_detect: handleSolidDetect,
  solid_find_by_text: handleSolidFindByText,
  solid_find_by_role: handleSolidFindByRole,
  redux_get_state: handleReduxGetState,
  redux_subscribe: handleReduxSubscribe,
  redux_dispatch: handleReduxDispatch,
  store_get_state: handleStoreGetState,
  store_subscribe: handleStoreSubscribe,
  store_dispatch: handleStoreDispatch,
  source_map_resolve: handleSourceMapResolve,
  session_record: handleSessionRecord,
  sw_status: handleSwStatus,
  cache_list: handleCacheList,
  cache_inspect: handleCacheInspect,
  cache_match: handleCacheMatch,
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
