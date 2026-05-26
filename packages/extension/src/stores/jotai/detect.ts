/**
 * Page-world Jotai store detection — explicit-handoff path
 * (window.__pwaDebug_jotai).
 *
 * Jotai diverges most from the path-addressable StoreHandle model: state lives
 * across opaque atom references in a store (createStore()), with no single tree
 * and no names. So the handoff is a WRAPPED shape — { store, atoms } — pairing
 * the store instance with a name->atom registry the app chooses to expose. The
 * adapter projects that into a name-keyed snapshot so the generic path_get /
 * serialize / subscribe layer works unchanged.
 *
 * A Jotai dev-store auto-discovery path (enumerate atoms via
 * store.dev4_get_mounted_atoms in dev builds) lands in M44 — see ./dev_discover
 * and ./discover; this module owns the explicit-handoff path and the shared
 * store/handoff duck-type guards.
 *
 * Pure: no DOM, no chrome.* — duck-typed reads only.
 */

/** The minimal Jotai store surface this module needs (createStore() result). */
export type JotaiStore = {
  readonly get: (atom: unknown) => unknown;
  readonly set: (atom: unknown, value: unknown) => void;
  readonly sub: (atom: unknown, listener: () => void) => () => void;
};

/**
 * Duck-type guard for the bare Jotai store surface ({ get, set, sub }). Shared
 * by the explicit-handoff check below and the fiber-context discoverer
 * (./discover), so the store shape is defined once. Distinct from Redux
 * (getState/dispatch), Zustand (setState) and Pinia ($state/$patch), so no
 * adapter cross-claims a Jotai store.
 */
export const isJotaiStore = (v: unknown): v is JotaiStore => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['get'] === 'function' &&
    typeof r['set'] === 'function' &&
    typeof r['sub'] === 'function'
  );
};

/** The wrapped handoff: a store + a name->atom registry to introspect. */
export type JotaiHandoff = {
  readonly store: JotaiStore;
  readonly atoms: Readonly<Record<string, unknown>>;
};

/** Scope shape — only the property name we read is part of the contract. */
export type JotaiDetectScope = {
  readonly __pwaDebug_jotai?: unknown;
};

const isJotaiHandoff = (v: unknown): v is JotaiHandoff => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const atoms = r['atoms'];
  if (atoms === null || typeof atoms !== 'object') return false;
  return isJotaiStore(r['store']);
};

/**
 * Find the Jotai handoff via scope.__pwaDebug_jotai. Returns the { store, atoms }
 * pair, or null when absent or malformed.
 */
export const detectJotaiHandoff = (
  scope: JotaiDetectScope,
): JotaiHandoff | null => {
  const candidate = scope.__pwaDebug_jotai;
  if (candidate !== undefined && isJotaiHandoff(candidate)) return candidate;
  return null;
};
