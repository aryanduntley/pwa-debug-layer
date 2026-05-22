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
 * A Jotai devtools auto-discovery path (store.dev_get_mounted_atoms /
 * dev_subscribe_store in dev builds) is a future follow-on; M5 is explicit
 * handoff only.
 *
 * Pure: no DOM, no chrome.* — duck-typed reads only.
 */

/** The minimal Jotai store surface this module needs (createStore() result). */
export type JotaiStore = {
  readonly get: (atom: unknown) => unknown;
  readonly set: (atom: unknown, value: unknown) => void;
  readonly sub: (atom: unknown, listener: () => void) => () => void;
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
  const store = r['store'];
  const atoms = r['atoms'];
  if (store === null || typeof store !== 'object') return false;
  if (atoms === null || typeof atoms !== 'object') return false;
  const s = store as Record<string, unknown>;
  return (
    typeof s['get'] === 'function' &&
    typeof s['set'] === 'function' &&
    typeof s['sub'] === 'function'
  );
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
