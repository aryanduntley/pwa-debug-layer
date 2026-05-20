/**
 * Page-world Redux store detection — T1 path: explicit fixture handoff via
 * `window.__pwaDebug_redux`. M11 T2 will add a second detection path (a
 * __REDUX_DEVTOOLS_EXTENSION__ shim that captures user stores at create-time);
 * the T2 caller composes both paths and falls back from devtools→handoff.
 *
 * Pure: no DOM access, no chrome.* — caller passes the candidate scope (window
 * in production, mock in tests). Duck-typed validation only; we never call
 * methods on the candidate at detection time.
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

const isReduxLike = (v: unknown): v is ReduxStoreHandle => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['getState'] === 'function' &&
    typeof r['subscribe'] === 'function' &&
    typeof r['dispatch'] === 'function'
  );
};

/** Getter returned by installReduxDevtoolsShim — accepted as the second
 *  detection path so the orchestrator can compose explicit handoff + shim. */
export type ReduxShimGetStores = () => readonly ReduxStoreHandle[];

/**
 * Find the active Redux store. Resolution order:
 *  1. scope.__pwaDebug_redux (M11 T1 explicit fixture handoff — kept for
 *     manual smoke testing AND for cases where the user creates the store
 *     before our page-world shim runs).
 *  2. shimGetStores()[0] (M11 T2 production path — populated by
 *     installReduxDevtoolsShim when the user's RTK calls
 *     __REDUX_DEVTOOLS_EXTENSION_COMPOSE__ / __REDUX_DEVTOOLS_EXTENSION__).
 * Returns null when neither yields a valid Redux-shaped store.
 */
export const detectReduxStore = (
  scope: DetectScope,
  shimGetStores?: ReduxShimGetStores,
): ReduxStoreHandle | null => {
  const candidate = scope.__pwaDebug_redux;
  if (candidate !== undefined && isReduxLike(candidate)) return candidate;
  if (shimGetStores !== undefined) {
    const stores = shimGetStores();
    if (stores.length > 0) {
      const first = stores[0];
      if (first !== undefined && isReduxLike(first)) return first;
    }
  }
  return null;
};
