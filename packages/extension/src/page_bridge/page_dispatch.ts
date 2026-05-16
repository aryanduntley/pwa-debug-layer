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

const HANDLERS: Readonly<Record<string, PageWorldHandler>> = Object.freeze({
  session_ping: () => sessionPingHandler(),
  evaluate: (env) => evaluateHandler(env),
  react_tree: (env) => reactTreeHandler(env),
  react_get_state: (env) => reactGetStateHandler(env),
  react_find_by_text: (env) => reactFindByTextHandler(env),
  react_find_by_role: (env) => reactFindByRoleHandler(env),
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
