/**
 * Page-world Zustand store detection — M3 explicit-handoff path
 * (window.__pwaDebug_zustand), mirroring the Redux T1 contract.
 *
 * Zustand stores are module-local (`const useStore = create(...)`), never on a
 * global by default, so there is no ambient way to find them. M3 supports the
 * explicit fixture/app handoff only. The Zustand devtools-middleware
 * auto-capture path is deferred: that middleware drives
 * __REDUX_DEVTOOLS_EXTENSION__.connect(), NOT the enhancer-over-createStore
 * pattern the Redux shim intercepts, so it needs its own shim (with breakage
 * risk) — a future milestone. The optional shimGetStores parameter is reserved
 * for that path but unused today.
 *
 * Disambiguation from Redux: a Zustand vanilla store exposes setState; a Redux
 * store does not. Requiring setState here (and dispatch in the Redux guard)
 * keeps the two adapters from claiming each other's stores.
 *
 * Pure: no DOM, no chrome.* — duck-typed reads only, never invoked at detect.
 */

/** The minimal Zustand vanilla-store surface this module needs. */
export type ZustandVanillaStore = {
  readonly getState: () => unknown;
  readonly setState: (partial: unknown, replace?: boolean) => void;
  readonly subscribe: (
    listener: (state: unknown, prev: unknown) => void,
  ) => () => void;
};

/** Scope shape — only the property name we read is part of the contract. */
export type ZustandDetectScope = {
  readonly __pwaDebug_zustand?: unknown;
};

/** Getter reserved for a future Zustand devtools shim path (unused in M3). */
export type ZustandShimGetStores = () => readonly ZustandVanillaStore[];

const isZustandLike = (v: unknown): v is ZustandVanillaStore => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['getState'] === 'function' &&
    typeof r['setState'] === 'function' &&
    typeof r['subscribe'] === 'function'
  );
};

/**
 * Find the active Zustand store. Resolution order:
 *  1. scope.__pwaDebug_zustand (explicit handoff — the only M3 path).
 *  2. shimGetStores()[0] (reserved for a future devtools path; unused now).
 * Returns null when neither yields a Zustand-shaped store.
 */
export const detectZustandStore = (
  scope: ZustandDetectScope,
  shimGetStores?: ZustandShimGetStores,
): ZustandVanillaStore | null => {
  const candidate = scope.__pwaDebug_zustand;
  if (candidate !== undefined && isZustandLike(candidate)) return candidate;
  if (shimGetStores !== undefined) {
    const stores = shimGetStores();
    const first = stores[0];
    if (first !== undefined && isZustandLike(first)) return first;
  }
  return null;
};
