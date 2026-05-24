/**
 * Page-world Redux store detection.
 *
 * Resolution order (the caller composes both via the injected getStores seam):
 *  1. window.__pwaDebug_redux — explicit handoff (manual smoke, and stores that
 *     fiber discovery can't reach, e.g. vanilla non-React Redux).
 *  2. getStores()[first redux-shaped] — PASSIVE react-redux discovery off the
 *     React fiber tree (M46; see ./discover). This replaced the removed
 *     __REDUX_DEVTOOLS_EXTENSION__ impersonation shim, which broke RTK apps by
 *     sitting in their store-creation path. Discovery is read-only and never
 *     participates in store creation.
 *
 * Pure: no DOM access, no chrome.* — the caller passes the candidate scope
 * (window in production, mock in tests) and the getStores provider. Duck-typed
 * validation only; we never call methods on the candidate at detection time.
 */

/** The minimal Redux store surface this module needs. */
export type ReduxStoreHandle = {
  readonly getState: () => unknown;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (action: { readonly type: string }) => unknown;
};

/** Scope shape — only the property names we read are part of the contract. */
export type DetectScope = {
  readonly __pwaDebug_redux?: unknown;
};

/** Duck-type guard for the minimal Redux store surface. Shared with ./discover. */
export const isReduxLike = (v: unknown): v is ReduxStoreHandle => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['getState'] === 'function' &&
    typeof r['subscribe'] === 'function' &&
    typeof r['dispatch'] === 'function'
  );
};

/**
 * Provider of auto-discovered Redux stores (M46 passive fiber-context discovery
 * — see ./discover). Returns [] when none are found. Framework-neutral seam so
 * detect.ts stays DOM-free.
 */
export type ReduxGetStores = () => readonly ReduxStoreHandle[];

/**
 * Find the active Redux store. Resolution order:
 *  1. scope.__pwaDebug_redux (explicit handoff — wins when present).
 *  2. getStores()[first redux-shaped] (passive fiber-context discovery).
 * Returns null when neither yields a valid Redux-shaped store.
 */
export const detectReduxStore = (
  scope: DetectScope,
  getStores?: ReduxGetStores,
): ReduxStoreHandle | null => {
  const candidate = scope.__pwaDebug_redux;
  if (candidate !== undefined && isReduxLike(candidate)) return candidate;
  if (getStores !== undefined) {
    for (const s of getStores()) {
      if (isReduxLike(s)) return s;
    }
  }
  return null;
};
