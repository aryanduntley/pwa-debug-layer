import {
  encodeResponse,
  type PageBridgeRequestEnvelope,
  type PageBridgeResponseEnvelope,
} from './protocol.js';
import { serializeArgs } from '../captures/serialize.js';
import {
  serializeTree,
  type ReactTreeOptions,
  type ReactTreeResult,
} from '../react/serialize_tree.js';
import { findReactRoots } from '../react/find_react_roots.js';
import { resolveStableId } from '../react/resolve_stable_id.js';
import {
  serializeComponent,
  type ReactComponentInfo,
  type SerializeComponentOptions,
} from '../react/serialize_component.js';
import { findByText, type FindByTextResult } from '../react/find_by_text.js';
import { findByRole, type FindByRoleResult } from '../react/find_by_role.js';
import { detectReduxStore } from '../stores/redux/detect.js';
import { getValueAtPath } from '../stores/redux/path_get.js';
import { serializeStoreValue } from '../stores/redux/serialize.js';
import type { ReduxDevtoolsShim } from '../stores/redux/devtools_shim.js';
import { installStoreSubscription } from '../stores/redux/subscribe.js';
import { discoverSourceMapUrl } from '../sourcemap/discover.js';
import { resolveLocation, type ResolvedFrame } from '../sourcemap/resolve.js';
import {
  createSourcemapCache,
  type SourcemapCache,
} from '../sourcemap/cache.js';
import {
  startRecording,
  stopRecording,
  getActiveSessionId,
  getActiveDurationCapMs,
} from '../rrweb_record/state.js';
import type { ReplayCapturedEvent } from '@pwa-debug/shared';
import { safeRandomId } from '../ids/safe_random_id.js';
import type {
  StoreChangeCapturedEvent,
  CapturedEvent,
} from '@pwa-debug/shared';
import { encodeEvent } from './protocol.js';
import { computeFrameMeta } from '../frame_meta/frame_meta.js';
import type { Disposer } from '../captures/capture_console.js';

// Singleton injected by page-world.ts bootstrap so reduxGetStateHandler can
// consult the shim's captured stores as a second detection path. Kept as a
// module-level binding here rather than on a global so tests can reset it.
let reduxShim: ReduxDevtoolsShim | null = null;

export const setReduxShim = (shim: ReduxDevtoolsShim | null): void => {
  reduxShim = shim;
};

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

export const readReactTreeInput = (raw: unknown): ReactTreeOptions => {
  if (raw === null || typeof raw !== 'object') return Object.freeze({});
  const r = raw as Record<string, unknown>;
  const out: { rootIndex?: number; depthLimit?: number; maxNodes?: number } = {};
  const rootIdx = r['root_index'];
  if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
    out.rootIndex = rootIdx;
  }
  const depth = r['depth_limit'];
  if (typeof depth === 'number' && Number.isInteger(depth) && depth > 0) {
    out.depthLimit = depth;
  }
  const max = r['max_nodes'];
  if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
    out.maxNodes = max;
  }
  return Object.freeze(out);
};

export const reactTreeHandler = (
  env: PageBridgeRequestEnvelope,
): ReactTreeResult => {
  const options = readReactTreeInput(env.payload);
  return serializeTree(document, options);
};

type ReactGetStateInternal = {
  readonly stableId: string;
  readonly rootIndex: number;
  readonly options: SerializeComponentOptions;
};

export const readReactGetStateInput = (
  raw: unknown,
): ReactGetStateInternal | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stableId = r['stable_id'];
  if (typeof stableId !== 'string' || stableId.length === 0) return null;
  const rootIdx = r['root_index'];
  const rootIndex =
    typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0
      ? rootIdx
      : 0;
  const options: { includeProps?: boolean; includeHooks?: boolean } = {};
  if (typeof r['include_props'] === 'boolean') options.includeProps = r['include_props'];
  if (typeof r['include_hooks'] === 'boolean') options.includeHooks = r['include_hooks'];
  return Object.freeze({ stableId, rootIndex, options: Object.freeze(options) });
};

export type ReactGetStateErrorPayload = {
  readonly error: { readonly message: string };
};

export const reactGetStateHandler = (
  env: PageBridgeRequestEnvelope,
): ReactComponentInfo | ReactGetStateErrorPayload => {
  const input = readReactGetStateInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'react_get_state: payload must be { stable_id: non-empty string, root_index?: number, include_props?: bool, include_hooks?: bool }',
      }),
    });
  }
  const roots = findReactRoots(document);
  const fiber = resolveStableId(input.stableId, roots);
  if (fiber === undefined) {
    return Object.freeze({
      error: Object.freeze({
        message: `react_get_state: stable_id "${input.stableId}" did not resolve. Re-call react.tree to refresh ids (the tree shape may have changed) or verify root_index matches the root used when the id was computed.`,
      }),
    });
  }
  return serializeComponent(fiber, input.rootIndex, input.options);
};

export type ReactFindByTextInput = {
  readonly pattern: string;
  readonly exact: boolean;
  readonly rootIndex?: number;
  readonly maxMatches?: number;
};

export const readReactFindByTextInput = (
  raw: unknown,
): ReactFindByTextInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pattern = r['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  const out: {
    pattern: string;
    exact: boolean;
    rootIndex?: number;
    maxMatches?: number;
  } = { pattern, exact: r['exact'] === true };
  const rootIdx = r['root_index'];
  if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
    out.rootIndex = rootIdx;
  }
  const max = r['max_matches'];
  if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
    out.maxMatches = max;
  }
  return Object.freeze(out);
};

// Reuses the generic { error: { message } } shape exported as
// ReactGetStateErrorPayload — tool-level errors are wire-successful by
// convention (mirrors reactGetStateHandler).
export const reactFindByTextHandler = (
  env: PageBridgeRequestEnvelope,
): FindByTextResult | ReactGetStateErrorPayload => {
  const input = readReactFindByTextInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'react_find_by_text: payload must be { pattern: non-empty string, exact?: bool, root_index?: number, max_matches?: number }',
      }),
    });
  }
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern);
  } catch (err) {
    return Object.freeze({
      error: Object.freeze({
        message: `react_find_by_text: invalid regex pattern: ${(err as Error).message}`,
      }),
    });
  }
  return findByText(document, regex, {
    exact: input.exact,
    ...(input.rootIndex !== undefined ? { rootIndex: input.rootIndex } : {}),
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
  });
};

export type ReactFindByRoleInput = {
  readonly role: string;
  readonly name?: string;
  readonly rootIndex?: number;
  readonly maxMatches?: number;
};

export const readReactFindByRoleInput = (
  raw: unknown,
): ReactFindByRoleInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const role = r['role'];
  if (typeof role !== 'string' || role.length === 0) return null;
  const out: {
    role: string;
    name?: string;
    rootIndex?: number;
    maxMatches?: number;
  } = { role };
  if (typeof r['name'] === 'string' && r['name'].length > 0) {
    out.name = r['name'];
  }
  const rootIdx = r['root_index'];
  if (typeof rootIdx === 'number' && Number.isInteger(rootIdx) && rootIdx >= 0) {
    out.rootIndex = rootIdx;
  }
  const max = r['max_matches'];
  if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
    out.maxMatches = max;
  }
  return Object.freeze(out);
};

// Reuses the generic { error: { message } } shape (ReactGetStateErrorPayload);
// tool-level errors are wire-successful by convention.
export const reactFindByRoleHandler = (
  env: PageBridgeRequestEnvelope,
): FindByRoleResult | ReactGetStateErrorPayload => {
  const input = readReactFindByRoleInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'react_find_by_role: payload must be { role: non-empty string, name?: string, root_index?: number, max_matches?: number }',
      }),
    });
  }
  let nameRe: RegExp | undefined;
  if (input.name !== undefined) {
    try {
      nameRe = new RegExp(input.name);
    } catch (err) {
      return Object.freeze({
        error: Object.freeze({
          message: `react_find_by_role: invalid name regex: ${(err as Error).message}`,
        }),
      });
    }
  }
  return findByRole(document, input.role, nameRe, {
    ...(input.rootIndex !== undefined ? { rootIndex: input.rootIndex } : {}),
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
  });
};

export type ReduxGetStateInput = {
  readonly path?: string;
};

export type ReduxGetStateSuccess = {
  readonly state: unknown;
  readonly path?: string;
  readonly truncated?: boolean;
  readonly scopeUrl: string;
};

export type ReduxGetStateErrorPayload = {
  readonly error: { readonly message: string };
};

export const readReduxGetStateInput = (
  raw: unknown,
): ReduxGetStateInput => {
  if (raw === null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const path = r['path'];
  if (typeof path === 'string' && path.length > 0) {
    return Object.freeze({ path });
  }
  return Object.freeze({});
};

export const reduxGetStateHandler = (
  env: PageBridgeRequestEnvelope,
): ReduxGetStateSuccess | ReduxGetStateErrorPayload => {
  const input = readReduxGetStateInput(env.payload);
  const store = detectReduxStore(
    window as unknown as { __pwaDebug_redux?: unknown },
    reduxShim !== null ? reduxShim.getStores : undefined,
  );
  if (store === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'redux_get_state: no Redux store detected. Fixture/page must expose the store on window.__pwaDebug_redux (T1 path); production auto-detection via the __REDUX_DEVTOOLS_EXTENSION__ shim ships in M11 T2.',
      }),
    });
  }
  const state = store.getState();
  const picked = getValueAtPath(state, input.path);
  if (!picked.ok) {
    return Object.freeze({
      error: Object.freeze({
        message: `redux_get_state: path "${input.path ?? ''}" invalid: ${picked.error}`,
      }),
    });
  }
  const serialized = serializeStoreValue(picked.value);
  const out: {
    state: unknown;
    path?: string;
    truncated?: boolean;
    scopeUrl: string;
  } = {
    state: serialized.value,
    scopeUrl: window.location.href,
  };
  if (input.path !== undefined) out.path = input.path;
  if (serialized.truncated) out.truncated = true;
  return Object.freeze(out);
};

export type ReduxSubscribeInput = {
  readonly action: 'start' | 'stop';
  readonly path?: string;
};

export type ReduxSubscribeSuccess = {
  readonly active: boolean;
  readonly path?: string;
  readonly scopeUrl: string;
};

export type ReduxSubscribeErrorPayload = {
  readonly error: { readonly message: string };
};

export const readReduxSubscribeInput = (
  raw: unknown,
): ReduxSubscribeInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (action !== 'start' && action !== 'stop') return null;
  const path = r['path'];
  if (path !== undefined && (typeof path !== 'string' || path.length === 0)) {
    return null;
  }
  return Object.freeze(
    path !== undefined
      ? ({ action, path } as ReduxSubscribeInput)
      : ({ action } as ReduxSubscribeInput),
  );
};

// Module-singleton: tracks the active store_change subscription's disposer.
// The page-world bootstrap owns the captures emit path through encodeEvent +
// window.postMessage; reduxSubscribeHandler reuses it so emits flow through
// the normal CS → SW → host buffer pipeline.
let subscriptionDisposer: Disposer | null = null;

const emitToPage = (event: CapturedEvent): void => {
  window.postMessage(encodeEvent(event), window.location.origin);
};

export const reduxSubscribeHandler = (
  env: PageBridgeRequestEnvelope,
): ReduxSubscribeSuccess | ReduxSubscribeErrorPayload => {
  const input = readReduxSubscribeInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          "redux_subscribe: payload must be { action: 'start' | 'stop', path?: non-empty string }",
      }),
    });
  }
  if (input.action === 'stop') {
    if (subscriptionDisposer !== null) {
      subscriptionDisposer();
      subscriptionDisposer = null;
    }
    return Object.freeze({
      active: false,
      scopeUrl: window.location.href,
    });
  }
  const store = detectReduxStore(
    window as unknown as { __pwaDebug_redux?: unknown },
    reduxShim !== null ? reduxShim.getStores : undefined,
  );
  if (store === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'redux_subscribe: no Redux store detected. Fixture/page must expose the store on window.__pwaDebug_redux, or the production __REDUX_DEVTOOLS_EXTENSION__ shim must be in place.',
      }),
    });
  }
  // Validate path eagerly so misuse fails at start, not silently later.
  if (input.path !== undefined) {
    const probe = getValueAtPath(store.getState(), input.path);
    if (!probe.ok) {
      return Object.freeze({
        error: Object.freeze({
          message: `redux_subscribe: path "${input.path}" invalid: ${probe.error}`,
        }),
      });
    }
  }
  // Tear down any prior subscription before installing the new one.
  if (subscriptionDisposer !== null) {
    subscriptionDisposer();
    subscriptionDisposer = null;
  }
  subscriptionDisposer = installStoreSubscription({
    store,
    emit: (e: StoreChangeCapturedEvent) => emitToPage(e),
    frame: computeFrameMeta(),
    ...(input.path !== undefined ? { path: input.path } : {}),
  });
  const out: {
    active: boolean;
    path?: string;
    scopeUrl: string;
  } = { active: true, scopeUrl: window.location.href };
  if (input.path !== undefined) out.path = input.path;
  return Object.freeze(out);
};

export type ReduxDispatchAction = {
  readonly type: string;
  readonly payload?: unknown;
};

export type ReduxDispatchSuccess = {
  readonly dispatched: true;
  readonly action: ReduxDispatchAction;
  readonly scopeUrl: string;
};

export type ReduxDispatchErrorPayload = {
  readonly error: { readonly message: string };
};

export const readReduxDispatchInput = (
  raw: unknown,
): ReduxDispatchAction | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (action === null || typeof action !== 'object') return null;
  const a = action as Record<string, unknown>;
  const type = a['type'];
  if (typeof type !== 'string' || type.length === 0) return null;
  const out: { type: string; payload?: unknown } = { type };
  if ('payload' in a) out.payload = a['payload'];
  return Object.freeze(out);
};

export const reduxDispatchHandler = (
  env: PageBridgeRequestEnvelope,
): ReduxDispatchSuccess | ReduxDispatchErrorPayload => {
  const action = readReduxDispatchInput(env.payload);
  if (action === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'redux_dispatch: payload must be { action: { type: non-empty string; payload? } }',
      }),
    });
  }
  const store = detectReduxStore(
    window as unknown as { __pwaDebug_redux?: unknown },
    reduxShim !== null ? reduxShim.getStores : undefined,
  );
  if (store === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'redux_dispatch: no Redux store detected. Fixture/page must expose the store on window.__pwaDebug_redux, or the __REDUX_DEVTOOLS_EXTENSION__ shim must capture it.',
      }),
    });
  }
  try {
    store.dispatch(action);
  } catch (err) {
    return Object.freeze({
      error: Object.freeze({
        message: `redux_dispatch: store.dispatch threw: ${(err as Error).message}`,
      }),
    });
  }
  return Object.freeze({
    dispatched: true as const,
    action,
    scopeUrl: window.location.href,
  });
};

export type SourceMapResolveInput = {
  readonly scriptUrl: string;
  readonly line: number;
  readonly column: number;
};

export type SourceMapResolveSuccess = {
  readonly original?: ResolvedFrame;
  readonly scopeUrl: string;
};

export type SourceMapResolveErrorPayload = {
  readonly error: { readonly message: string };
};

export const readSourceMapResolveInput = (
  raw: unknown,
): SourceMapResolveInput | null => {
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
  return Object.freeze({ scriptUrl, line, column });
};

let sourcemapCache: SourcemapCache | null = null;

const getSourcemapCache = (): SourcemapCache => {
  if (sourcemapCache === null) {
    sourcemapCache = createSourcemapCache();
  }
  return sourcemapCache;
};

export const resetSourcemapCache = (): void => {
  sourcemapCache = null;
};

export const sourceMapResolveHandler = async (
  env: PageBridgeRequestEnvelope,
): Promise<SourceMapResolveSuccess | SourceMapResolveErrorPayload> => {
  const input = readSourceMapResolveInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'source_map_resolve: payload must be { script_url: non-empty string, line: int >= 1, column: int >= 0 }',
      }),
    });
  }
  let scriptText: string;
  try {
    const res = await fetch(input.scriptUrl);
    if (!res.ok) {
      return Object.freeze({
        error: Object.freeze({
          message: `source_map_resolve: script fetch returned ${res.status}`,
        }),
      });
    }
    scriptText = await res.text();
  } catch (err) {
    return Object.freeze({
      error: Object.freeze({
        message: `source_map_resolve: script fetch failed: ${(err as Error).message}`,
      }),
    });
  }
  const mapUrl = discoverSourceMapUrl(input.scriptUrl, scriptText);
  if (mapUrl === null) {
    return Object.freeze({
      scopeUrl: window.location.href,
    });
  }
  const cache = getSourcemapCache();
  const parsed = await cache.get(mapUrl);
  if (parsed === null) {
    return Object.freeze({
      scopeUrl: window.location.href,
    });
  }
  const original = resolveLocation(parsed, input.line, input.column);
  const out: { original?: ResolvedFrame; scopeUrl: string } = {
    scopeUrl: window.location.href,
  };
  if (original !== null) out.original = original;
  return Object.freeze(out);
};

export type SessionRecordInput = {
  readonly action: 'start' | 'stop';
  readonly sessionId?: string;
  readonly durationCapMs?: number;
};

export type SessionRecordSuccess = {
  readonly active: boolean;
  readonly sessionId?: string;
  readonly durationCapMs?: number;
  readonly scopeUrl: string;
};

export type SessionRecordErrorPayload = {
  readonly error: { readonly message: string };
};

export const readSessionRecordInput = (
  raw: unknown,
): SessionRecordInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (action !== 'start' && action !== 'stop') return null;
  const out: { action: 'start' | 'stop'; sessionId?: string; durationCapMs?: number } = {
    action,
  };
  const sid = r['session_id'];
  if (sid !== undefined) {
    if (typeof sid !== 'string' || sid.length === 0) return null;
    out.sessionId = sid;
  }
  const cap = r['duration_cap_ms'];
  if (cap !== undefined) {
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0) return null;
    out.durationCapMs = cap;
  }
  return Object.freeze(out);
};

export const sessionRecordHandler = (
  env: PageBridgeRequestEnvelope,
): SessionRecordSuccess | SessionRecordErrorPayload => {
  const input = readSessionRecordInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          "session_record: payload must be { action: 'start' | 'stop', session_id?: non-empty string, duration_cap_ms?: int > 0 }",
      }),
    });
  }
  if (input.action === 'stop') {
    const sid = stopRecording();
    const out: { active: false; sessionId?: string; scopeUrl: string } = {
      active: false as const,
      scopeUrl: window.location.href,
    };
    if (sid !== null) out.sessionId = sid;
    return Object.freeze(out);
  }
  const sessionId = input.sessionId ?? safeRandomId();
  const frame = computeFrameMeta();
  startRecording({
    emit: (e: ReplayCapturedEvent) =>
      window.postMessage(encodeEvent(e), window.location.origin),
    frame,
    sessionId,
    ...(input.durationCapMs !== undefined ? { durationCapMs: input.durationCapMs } : {}),
  });
  const out: {
    active: true;
    sessionId: string;
    durationCapMs?: number;
    scopeUrl: string;
  } = {
    active: true as const,
    sessionId: getActiveSessionId() ?? sessionId,
    scopeUrl: window.location.href,
  };
  const dur = getActiveDurationCapMs();
  if (dur !== undefined) out.durationCapMs = dur;
  return Object.freeze(out);
};

const HANDLERS: Readonly<Record<string, PageWorldHandler>> = Object.freeze({
  session_ping: () => sessionPingHandler(),
  evaluate: (env) => evaluateHandler(env),
  react_tree: (env) => reactTreeHandler(env),
  react_get_state: (env) => reactGetStateHandler(env),
  react_find_by_text: (env) => reactFindByTextHandler(env),
  react_find_by_role: (env) => reactFindByRoleHandler(env),
  redux_get_state: (env) => reduxGetStateHandler(env),
  redux_subscribe: (env) => reduxSubscribeHandler(env),
  redux_dispatch: (env) => reduxDispatchHandler(env),
  source_map_resolve: (env) => sourceMapResolveHandler(env),
  session_record: (env) => sessionRecordHandler(env),
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
