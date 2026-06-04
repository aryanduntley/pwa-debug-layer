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
import { runAction, readActionInput } from '../interaction_locator/action_dispatch.js';
import { ACTION_TOOL_SPECS } from '@pwa-debug/shared';
import {
  serializeVueTree,
  type VueTreeOptions,
  type VueTreeResult,
} from '../vue/serialize_tree.js';
import {
  serializeVueComponent,
  type VueComponentInfo,
  type SerializeVueComponentOptions,
} from '../vue/serialize_component.js';
import { findVueRoots } from '../vue/find_vue_roots.js';
import { resolveStableId as resolveVueStableId } from '../vue/resolve_stable_id.js';
import { findVueByText, type FindVueByTextResult } from '../vue/find_by_text.js';
import { findVueByRole, type FindVueByRoleResult } from '../vue/find_by_role.js';
import { detectSvelte } from '../svelte/detect.js';
import { discoverSvelteComponents } from '../svelte/discover.js';
import type { SvelteComponent } from '../svelte/types.js';
import {
  findSvelteByText,
  type FindSvelteByTextResult,
} from '../svelte/find_by_text.js';
import {
  findSvelteByRole,
  type FindSvelteByRoleResult,
} from '../svelte/find_by_role.js';
import { detectSolid } from '../solid/detect.js';
import type { SolidDetection } from '../solid/types.js';
import {
  findSolidByText,
  type FindSolidByTextResult,
} from '../solid/find_by_text.js';
import {
  findSolidByRole,
  type FindSolidByRoleResult,
} from '../solid/find_by_role.js';
import { detectStore } from '../stores/registry.js';
import { discoverPiniaStores } from '../stores/pinia/discover.js';
import { discoverReduxStores } from '../stores/redux/discover.js';
import { discoverJotaiStores } from '../stores/jotai/discover.js';
import { getValueAtPath } from '../stores/redux/path_get.js';
import { serializeStoreValue } from '../stores/redux/serialize.js';
import type { ZustandDevtoolsShim } from '../stores/zustand/devtools_shim.js';
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
import type {
  SwStatusSnapshot,
  CacheListResult,
  CacheInspectResult,
  CacheMatchResult,
  PwaStatusSnapshot,
  InstallabilityResult,
} from '@pwa-debug/shared';
import { projectServiceWorkerState } from '../sw_app/projection.js';
import {
  readCacheList,
  readCacheInspect,
  readCacheMatch,
} from '../cache_storage/read.js';
import {
  readPwaStatus,
  type WinLike,
  type NavLike,
} from '../pwa_status/read.js';
import { readInstallability } from '../pwa_installability/read.js';
import { readWebStorage, type StorageLike } from '../storage/web_storage.js';
import type { StorageArea, StorageGetResult } from '@pwa-debug/shared';

// Singleton injected by page-world.ts bootstrap so resolveStore can consult the
// Zustand devtools shim's connect-time captures as a detection path (mirrors
// reduxShim). Module-level binding, not a global, so tests can reset it.
let zustandShim: ZustandDevtoolsShim | null = null;

export const setZustandShim = (shim: ZustandDevtoolsShim | null): void => {
  zustandShim = shim;
};

// Resolve the live store via the framework-agnostic registry. Detection seams
// are threaded in via the DetectContext, all PASSIVE/read-only: Redux, Pinia and
// Jotai auto-discovery walk the live document (React fiber-context value for
// redux + jotai, Vue config.globalProperties.$pinia for pinia), and the Zustand
// devtools-connect shim's captured stores. An optional framework selector
// restricts detection to a single adapter (from the store_* tools' framework
// arg); when omitted, adapters are tried in priority order. Returns
// { framework, handle } | null.
const resolveStore = (framework?: string) =>
  detectStore(
    window,
    {
      reduxGetStores: () => discoverReduxStores(document),
      ...(zustandShim !== null
        ? { zustandShimGetStores: zustandShim.getStores }
        : {}),
      piniaGetStores: () => discoverPiniaStores(document),
      jotaiGetStores: () => discoverJotaiStores(document),
    },
    framework,
  );

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

// ── Vue introspection (Path 5 M39) — parity with react_tree/react_get_state ──

export const readVueTreeInput = (raw: unknown): VueTreeOptions => {
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

export const vueTreeHandler = (
  env: PageBridgeRequestEnvelope,
): VueTreeResult => serializeVueTree(document, readVueTreeInput(env.payload));

type VueGetStateInternal = {
  readonly stableId: string;
  readonly options: SerializeVueComponentOptions;
};

export const readVueGetStateInput = (
  raw: unknown,
): VueGetStateInternal | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stableId = r['stable_id'];
  if (typeof stableId !== 'string' || stableId.length === 0) return null;
  const options: { includeProps?: boolean; includeState?: boolean } = {};
  if (typeof r['include_props'] === 'boolean') options.includeProps = r['include_props'];
  if (typeof r['include_state'] === 'boolean') options.includeState = r['include_state'];
  return Object.freeze({ stableId, options: Object.freeze(options) });
};

// Reuses the generic { error: { message } } shape (ReactGetStateErrorPayload);
// tool-level errors are wire-successful by convention. The Vue stable id encodes
// its own root segment (root{i}/…), so resolveVueStableId needs no root_index.
export const vueGetStateHandler = (
  env: PageBridgeRequestEnvelope,
): VueComponentInfo | ReactGetStateErrorPayload => {
  const input = readVueGetStateInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'vue_get_state: payload must be { stable_id: non-empty string, include_props?: bool, include_state?: bool }',
      }),
    });
  }
  const roots = findVueRoots(document);
  const instance = resolveVueStableId(input.stableId, roots);
  if (instance === undefined) {
    return Object.freeze({
      error: Object.freeze({
        message: `vue_get_state: stable_id "${input.stableId}" did not resolve. Re-call vue_tree to refresh ids (the component tree may have changed).`,
      }),
    });
  }
  return serializeVueComponent(instance, 0, input.options);
};

export type VueFindByTextInput = {
  readonly pattern: string;
  readonly exact: boolean;
  readonly rootIndex?: number;
  readonly maxMatches?: number;
};

export const readVueFindByTextInput = (
  raw: unknown,
): VueFindByTextInput | null => {
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

export const vueFindByTextHandler = (
  env: PageBridgeRequestEnvelope,
): FindVueByTextResult | ReactGetStateErrorPayload => {
  const input = readVueFindByTextInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'vue_find_by_text: payload must be { pattern: non-empty string, exact?: bool, root_index?: number, max_matches?: number }',
      }),
    });
  }
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern);
  } catch (err) {
    return Object.freeze({
      error: Object.freeze({
        message: `vue_find_by_text: invalid regex pattern: ${(err as Error).message}`,
      }),
    });
  }
  return findVueByText(document, regex, {
    exact: input.exact,
    ...(input.rootIndex !== undefined ? { rootIndex: input.rootIndex } : {}),
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
  });
};

export type VueFindByRoleInput = {
  readonly role: string;
  readonly name?: string;
  readonly rootIndex?: number;
  readonly maxMatches?: number;
};

export const readVueFindByRoleInput = (
  raw: unknown,
): VueFindByRoleInput | null => {
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

export const vueFindByRoleHandler = (
  env: PageBridgeRequestEnvelope,
): FindVueByRoleResult | ReactGetStateErrorPayload => {
  const input = readVueFindByRoleInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'vue_find_by_role: payload must be { role: non-empty string, name?: string, root_index?: number, max_matches?: number }',
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
          message: `vue_find_by_role: invalid name regex: ${(err as Error).message}`,
        }),
      });
    }
  }
  return findVueByRole(document, input.role, nameRe, {
    ...(input.rootIndex !== undefined ? { rootIndex: input.rootIndex } : {}),
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
  });
};

// ── Svelte introspection (Path 5 M42) — partial parity (dev-mode, no state) ──

export type SvelteComponentsResult = {
  readonly present: boolean;
  readonly dev: boolean;
  readonly metaElementCount: number;
  readonly components: SvelteComponent[];
  readonly scopeUrl: string;
};

export const svelteComponentsHandler = (): SvelteComponentsResult => {
  const detection = detectSvelte(
    window as unknown as Parameters<typeof detectSvelte>[0],
    document,
  );
  return Object.freeze({
    present: detection.present,
    dev: detection.dev,
    metaElementCount: detection.metaElementCount,
    components: discoverSvelteComponents(document),
    scopeUrl: window.location.href,
  });
};

export type SvelteFindByTextInput = {
  readonly pattern: string;
  readonly exact: boolean;
  readonly maxMatches?: number;
};

export const readSvelteFindByTextInput = (
  raw: unknown,
): SvelteFindByTextInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pattern = r['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  const out: { pattern: string; exact: boolean; maxMatches?: number } = {
    pattern,
    exact: r['exact'] === true,
  };
  const max = r['max_matches'];
  if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
    out.maxMatches = max;
  }
  return Object.freeze(out);
};

export const svelteFindByTextHandler = (
  env: PageBridgeRequestEnvelope,
): FindSvelteByTextResult | ReactGetStateErrorPayload => {
  const input = readSvelteFindByTextInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'svelte_find_by_text: payload must be { pattern: non-empty string, exact?: bool, max_matches?: number }',
      }),
    });
  }
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern);
  } catch (err) {
    return Object.freeze({
      error: Object.freeze({
        message: `svelte_find_by_text: invalid regex pattern: ${(err as Error).message}`,
      }),
    });
  }
  return findSvelteByText(document, regex, {
    exact: input.exact,
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
  });
};

export type SvelteFindByRoleInput = {
  readonly role: string;
  readonly name?: string;
  readonly maxMatches?: number;
};

export const readSvelteFindByRoleInput = (
  raw: unknown,
): SvelteFindByRoleInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const role = r['role'];
  if (typeof role !== 'string' || role.length === 0) return null;
  const out: { role: string; name?: string; maxMatches?: number } = { role };
  if (typeof r['name'] === 'string' && r['name'].length > 0) out.name = r['name'];
  const max = r['max_matches'];
  if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
    out.maxMatches = max;
  }
  return Object.freeze(out);
};

export const svelteFindByRoleHandler = (
  env: PageBridgeRequestEnvelope,
): FindSvelteByRoleResult | ReactGetStateErrorPayload => {
  const input = readSvelteFindByRoleInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'svelte_find_by_role: payload must be { role: non-empty string, name?: string, max_matches?: number }',
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
          message: `svelte_find_by_role: invalid name regex: ${(err as Error).message}`,
        }),
      });
    }
  }
  return findSvelteByRole(document, input.role, nameRe, {
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
  });
};

// ── Solid introspection (Path 5 M43) — detection + DOM-level find only ───────

export type SolidDetectResult = SolidDetection & { readonly scopeUrl: string };

export const solidDetectHandler = (): SolidDetectResult => {
  const detection = detectSolid(
    window as unknown as Parameters<typeof detectSolid>[0],
    document,
  );
  return Object.freeze({ ...detection, scopeUrl: window.location.href });
};

export type SolidFindByTextInput = {
  readonly pattern: string;
  readonly exact: boolean;
  readonly maxMatches?: number;
};

export const readSolidFindByTextInput = (
  raw: unknown,
): SolidFindByTextInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pattern = r['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  const out: { pattern: string; exact: boolean; maxMatches?: number } = {
    pattern,
    exact: r['exact'] === true,
  };
  const max = r['max_matches'];
  if (typeof max === 'number' && Number.isInteger(max) && max > 0) out.maxMatches = max;
  return Object.freeze(out);
};

export const solidFindByTextHandler = (
  env: PageBridgeRequestEnvelope,
): FindSolidByTextResult | ReactGetStateErrorPayload => {
  const input = readSolidFindByTextInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'solid_find_by_text: payload must be { pattern: non-empty string, exact?: bool, max_matches?: number }',
      }),
    });
  }
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern);
  } catch (err) {
    return Object.freeze({
      error: Object.freeze({
        message: `solid_find_by_text: invalid regex pattern: ${(err as Error).message}`,
      }),
    });
  }
  return findSolidByText(document, regex, {
    exact: input.exact,
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
  });
};

export type SolidFindByRoleInput = {
  readonly role: string;
  readonly name?: string;
  readonly maxMatches?: number;
};

export const readSolidFindByRoleInput = (
  raw: unknown,
): SolidFindByRoleInput | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const role = r['role'];
  if (typeof role !== 'string' || role.length === 0) return null;
  const out: { role: string; name?: string; maxMatches?: number } = { role };
  if (typeof r['name'] === 'string' && r['name'].length > 0) out.name = r['name'];
  const max = r['max_matches'];
  if (typeof max === 'number' && Number.isInteger(max) && max > 0) out.maxMatches = max;
  return Object.freeze(out);
};

export const solidFindByRoleHandler = (
  env: PageBridgeRequestEnvelope,
): FindSolidByRoleResult | ReactGetStateErrorPayload => {
  const input = readSolidFindByRoleInput(env.payload);
  if (input === null) {
    return Object.freeze({
      error: Object.freeze({
        message:
          'solid_find_by_role: payload must be { role: non-empty string, name?: string, max_matches?: number }',
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
          message: `solid_find_by_role: invalid name regex: ${(err as Error).message}`,
        }),
      });
    }
  }
  return findSolidByRole(document, input.role, nameRe, {
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
  });
};

export type ReduxGetStateInput = {
  readonly path?: string;
  readonly framework?: string;
};

export type ReduxGetStateSuccess = {
  readonly framework: string;
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
  const out: { path?: string; framework?: string } = {};
  const path = r['path'];
  if (typeof path === 'string' && path.length > 0) out.path = path;
  const framework = r['framework'];
  if (typeof framework === 'string' && framework.length > 0) {
    out.framework = framework;
  }
  return Object.freeze(out);
};

/**
 * Actionable "no store detected" guidance, tailored per framework so a caller
 * who passed framework:'zustand' is told the real enablement path rather than a
 * Redux-centric message. Shared by every store handler's not-found branch. The
 * host MCP layer prepends the tool name, so these messages carry no prefix.
 *
 * There is no Chrome-DevTools / chrome-devtools-mcp fallback for store state —
 * CDP cannot read app-internal store state, so these tools are the only source.
 * The guidance points at the actual capture seams (auto-detect or handoff).
 */
const noStoreMessage = (framework?: string): string => {
  switch (framework) {
    case 'zustand':
      return `no Zustand store detected. Zero-config capture requires the store to use zustand's devtools() middleware (a Zustand store has no global or React-fiber handle, so there is no passive way to find one otherwise). If it does not use devtools(), expose the vanilla store via window.__pwaDebug_zustand = store for full read/subscribe/dispatch access.`;
    case 'redux':
      return `no Redux store detected. react-redux stores are auto-discovered from the React fiber tree; otherwise expose the store via window.__pwaDebug_redux = store.`;
    case 'pinia':
      return `no Pinia store detected. Pinia stores are auto-discovered from the live Vue app; otherwise expose a store via window.__pwaDebug_pinia.`;
    case 'jotai':
      return `no Jotai store resolved. The store is auto-discovered off the React <Provider store> context, but jotai >=2.12 removed the atom-enumeration API, so atom NAMES cannot be read from a bare store — expose them via window.__pwaDebug_jotai = { store, atoms } (the atom set is visible in your source, e.g. the module that calls atom()). On jotai 2.0–2.11 the atoms auto-enumerate with no handoff.`;
    default:
      return `no store detected. Rely on auto-detection (react-redux fiber discovery, Pinia Vue-app discovery, or Zustand devtools() middleware), or expose the store via a framework handoff (window.__pwaDebug_redux / __pwaDebug_zustand / __pwaDebug_pinia / __pwaDebug_jotai).`;
  }
};

export const reduxGetStateHandler = (
  env: PageBridgeRequestEnvelope,
): ReduxGetStateSuccess | ReduxGetStateErrorPayload => {
  const input = readReduxGetStateInput(env.payload);
  const detected = resolveStore(input.framework);
  if (detected === null) {
    return Object.freeze({
      error: Object.freeze({
        message: noStoreMessage(input.framework),
      }),
    });
  }
  const store = detected.handle;
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
    framework: string;
    state: unknown;
    path?: string;
    truncated?: boolean;
    scopeUrl: string;
  } = {
    framework: detected.framework,
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
  readonly framework?: string;
};

export type ReduxSubscribeSuccess = {
  readonly active: boolean;
  readonly framework?: string;
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
  const framework = r['framework'];
  if (
    framework !== undefined &&
    (typeof framework !== 'string' || framework.length === 0)
  ) {
    return null;
  }
  const out: { action: 'start' | 'stop'; path?: string; framework?: string } = {
    action,
  };
  if (path !== undefined) out.path = path as string;
  if (framework !== undefined) out.framework = framework as string;
  return Object.freeze(out);
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
  const detected = resolveStore(input.framework);
  if (detected === null) {
    return Object.freeze({
      error: Object.freeze({
        message: noStoreMessage(input.framework),
      }),
    });
  }
  const store = detected.handle;
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
    framework: detected.framework,
    ...(input.path !== undefined ? { path: input.path } : {}),
  });
  const out: {
    active: boolean;
    framework: string;
    path?: string;
    scopeUrl: string;
  } = { active: true, framework: detected.framework, scopeUrl: window.location.href };
  if (input.path !== undefined) out.path = input.path;
  return Object.freeze(out);
};

export type ReduxDispatchAction = {
  readonly type: string;
  readonly payload?: unknown;
};

export type ReduxDispatchSuccess = {
  readonly dispatched: true;
  readonly framework: string;
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
  const rawFramework =
    env.payload !== null && typeof env.payload === 'object'
      ? (env.payload as Record<string, unknown>)['framework']
      : undefined;
  const framework =
    typeof rawFramework === 'string' && rawFramework.length > 0
      ? rawFramework
      : undefined;
  const detected = resolveStore(framework);
  if (detected === null) {
    return Object.freeze({
      error: Object.freeze({
        message: noStoreMessage(framework),
      }),
    });
  }
  const store = detected.handle;
  if (typeof store.dispatch !== 'function') {
    return Object.freeze({
      error: Object.freeze({
        message:
          'redux_dispatch: detected store does not expose a dispatch() method.',
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
    framework: detected.framework,
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

// sw_status (PWA Runtime Diagnostics): read the DEBUGGED PWA's service-worker
// registrations + controller and project them to a wire SwStatusSnapshot. This
// is the app's navigator.serviceWorker — distinct from the extension's own
// sw_lifecycle module. Feature-detected so insecure/unsupported contexts return
// a { supported: false } snapshot rather than throwing.
export const swStatusHandler = async (): Promise<SwStatusSnapshot> => {
  const container = (navigator as Navigator).serviceWorker as
    | ServiceWorkerContainer
    | undefined;
  if (
    container === undefined ||
    typeof container.getRegistrations !== 'function'
  ) {
    return projectServiceWorkerState([], null, false);
  }
  const registrations = await container.getRegistrations();
  return projectServiceWorkerState(registrations, container.controller, true);
};

// cache_* (PWA Runtime Diagnostics): read the debugged PWA's CacheStorage. The
// readers take an injected CacheStorage; here we pass the live `caches` global
// (feature-detected → readers return supported:false when absent).
const getCacheStorage = (): CacheStorage | null =>
  typeof caches !== 'undefined' ? caches : null;

const DEFAULT_CACHE_INSPECT_LIMIT = 200;

export const cacheListHandler = (): Promise<CacheListResult> =>
  readCacheList(getCacheStorage());

export const cacheInspectHandler = (
  env: PageBridgeRequestEnvelope,
): Promise<CacheInspectResult | { readonly error: { readonly message: string } }> => {
  const r =
    env.payload !== null && typeof env.payload === 'object'
      ? (env.payload as Record<string, unknown>)
      : {};
  const name = r['cache_name'];
  if (typeof name !== 'string' || name.length === 0) {
    return Promise.resolve({
      error: { message: 'cache_inspect: payload must include { cache_name: non-empty string }' },
    });
  }
  const limit =
    typeof r['limit'] === 'number' &&
    Number.isInteger(r['limit']) &&
    (r['limit'] as number) > 0
      ? (r['limit'] as number)
      : DEFAULT_CACHE_INSPECT_LIMIT;
  return readCacheInspect(getCacheStorage(), name, limit, Date.now());
};

export const cacheMatchHandler = (
  env: PageBridgeRequestEnvelope,
): Promise<CacheMatchResult | { readonly error: { readonly message: string } }> => {
  const r =
    env.payload !== null && typeof env.payload === 'object'
      ? (env.payload as Record<string, unknown>)
      : {};
  const url = r['url'];
  if (typeof url !== 'string' || url.length === 0) {
    return Promise.resolve({
      error: { message: 'cache_match: payload must include { url: non-empty string }' },
    });
  }
  return readCacheMatch(getCacheStorage(), url, Date.now());
};

// pwa_status (PWA Runtime Diagnostics): runtime status + capability matrix of
// the debugged PWA, read from the live window + navigator.
export const pwaStatusHandler = (): Promise<PwaStatusSnapshot> =>
  readPwaStatus(window as unknown as WinLike, navigator as unknown as NavLike);

// pwa_installability: discover + fetch + parse the manifest from the live page
// and run the installability rules.
export const pwaInstallabilityHandler = async (): Promise<InstallabilityResult> => {
  const link = document.querySelector('link[rel="manifest"]');
  const manifestHref = link?.getAttribute('href') ?? null;
  const swContainer = (navigator as Navigator).serviceWorker as
    | ServiceWorkerContainer
    | undefined;
  let hasServiceWorker = false;
  if (swContainer !== undefined) {
    if (swContainer.controller !== null) {
      hasServiceWorker = true;
    } else if (typeof swContainer.getRegistration === 'function') {
      try {
        hasServiceWorker = (await swContainer.getRegistration()) !== undefined;
      } catch {
        hasServiceWorker = false;
      }
    }
  }
  return readInstallability({
    manifestHref,
    baseUrl: document.baseURI,
    secureContext: window.isSecureContext === true,
    hasServiceWorker,
    fetchText: async (url) => {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, text: await res.text() };
    },
  });
};

// storage_get (PWA Runtime Diagnostics T2): snapshot the debugged PWA's
// localStorage / sessionStorage. Feature-detected — a blocked/absent area yields
// supported:false rather than throwing.
const DEFAULT_STORAGE_LIMIT = 500;

const getWebStorage = (area: StorageArea): StorageLike | null => {
  try {
    const s = area === 'session' ? window.sessionStorage : window.localStorage;
    return (s as StorageLike | undefined) ?? null;
  } catch {
    // Access can throw when storage is disabled (e.g. third-party / blocked).
    return null;
  }
};

export const storageGetHandler = (
  env: PageBridgeRequestEnvelope,
): StorageGetResult | { readonly error: { readonly message: string } } => {
  const r =
    env.payload !== null && typeof env.payload === 'object'
      ? (env.payload as Record<string, unknown>)
      : {};
  const rawArea = r['area'];
  const area: StorageArea = rawArea === 'session' ? 'session' : 'local';
  const limit =
    typeof r['limit'] === 'number' &&
    Number.isInteger(r['limit']) &&
    (r['limit'] as number) > 0
      ? (r['limit'] as number)
      : DEFAULT_STORAGE_LIMIT;
  return readWebStorage(getWebStorage(area), area, limit);
};

// Path 7 interaction action tools (pdl_*): one handler per ACTION_TOOL_SPECS
// entry, each bound to its action kind — resolve the locator, apply the action.
const actionPageHandlers: Readonly<Record<string, PageWorldHandler>> = Object.freeze(
  Object.fromEntries(
    ACTION_TOOL_SPECS.map((s) => [
      s.tool,
      (env: PageBridgeRequestEnvelope) => {
        const input = readActionInput(env.payload);
        if (input === null) {
          return { error: { message: `${s.tool}: payload must include a locator` } };
        }
        return runAction(document, s.action, input.locator, input.params);
      },
    ]),
  ),
);

const HANDLERS: Readonly<Record<string, PageWorldHandler>> = Object.freeze({
  ...actionPageHandlers,
  session_ping: () => sessionPingHandler(),
  evaluate: (env) => evaluateHandler(env),
  react_tree: (env) => reactTreeHandler(env),
  react_get_state: (env) => reactGetStateHandler(env),
  react_find_by_text: (env) => reactFindByTextHandler(env),
  react_find_by_role: (env) => reactFindByRoleHandler(env),
  vue_tree: (env) => vueTreeHandler(env),
  vue_get_state: (env) => vueGetStateHandler(env),
  vue_find_by_text: (env) => vueFindByTextHandler(env),
  vue_find_by_role: (env) => vueFindByRoleHandler(env),
  svelte_components: () => svelteComponentsHandler(),
  svelte_find_by_text: (env) => svelteFindByTextHandler(env),
  svelte_find_by_role: (env) => svelteFindByRoleHandler(env),
  solid_detect: () => solidDetectHandler(),
  solid_find_by_text: (env) => solidFindByTextHandler(env),
  solid_find_by_role: (env) => solidFindByRoleHandler(env),
  redux_get_state: (env) => reduxGetStateHandler(env),
  redux_subscribe: (env) => reduxSubscribeHandler(env),
  redux_dispatch: (env) => reduxDispatchHandler(env),
  // Unified store_* family (Path 4 M2). Same framework-agnostic handlers as
  // redux_* — the framework arg in the payload selects an adapter, or the
  // registry auto-detects. redux_* kept as deprecated aliases.
  store_get_state: (env) => reduxGetStateHandler(env),
  store_subscribe: (env) => reduxSubscribeHandler(env),
  store_dispatch: (env) => reduxDispatchHandler(env),
  source_map_resolve: (env) => sourceMapResolveHandler(env),
  session_record: (env) => sessionRecordHandler(env),
  sw_status: () => swStatusHandler(),
  cache_list: () => cacheListHandler(),
  cache_inspect: (env) => cacheInspectHandler(env),
  cache_match: (env) => cacheMatchHandler(env),
  pwa_status: () => pwaStatusHandler(),
  pwa_installability: () => pwaInstallabilityHandler(),
  storage_get: (env) => storageGetHandler(env),
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
