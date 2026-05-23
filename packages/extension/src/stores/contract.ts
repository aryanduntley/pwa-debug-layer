/**
 * Framework-agnostic store-introspection contract. The single shape every
 * store adapter (Redux today; Zustand/Pinia/Jotai in later Path 4 milestones)
 * resolves to, so the page-world handlers and the host store_* tools never
 * branch per framework.
 *
 * Layering: this module depends on nothing framework-specific. Adapters import
 * FROM here; the registry composes adapters; page_dispatch consumes the
 * registry. `path_get` and `serialize` already operate on plain values and
 * stay framework-neutral as-is.
 *
 * Pure: types + one duck-type guard. No DOM, no chrome.*.
 */

/**
 * The minimal store surface the introspection layer needs. `dispatch` is
 * OPTIONAL: Redux always has it, but action-less stores (Zustand setState,
 * Jotai atom set) may not expose a Redux-style dispatch — the store_dispatch
 * handler guards on its presence rather than assuming it.
 */
export type StoreHandle = {
  readonly getState: () => unknown;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch?: (action: { readonly type: string }) => unknown;
};

/**
 * Per-detection inputs an adapter may consult beyond the raw scope. Extended
 * one optional field per framework as stores are added (M3 adds
 * `zustandShimGetStores`, etc.) — the central list of detection seams. Each
 * adapter reads only the field it owns; absent fields mean "no shim wired".
 */
export type DetectContext = {
  /** Stores captured at create-time by the Redux devtools shim (M11 T2). */
  readonly reduxShimGetStores?: () => readonly StoreHandle[];
  /**
   * Raw Pinia store candidates auto-discovered off the live Vue app's
   * config.globalProperties.$pinia registry (M37). Returns `unknown[]` to keep
   * this seam framework-neutral — the pinia adapter validates each candidate.
   */
  readonly piniaGetStores?: () => readonly unknown[];
};

/**
 * A registered store integration. `detect` returns the live store as a
 * StoreHandle or null when this framework's store is not present on the scope.
 * Adapters must be side-effect-free at detection time (duck-typed reads only).
 */
export type StoreAdapter = {
  readonly framework: string;
  readonly detect: (
    scope: unknown,
    ctx?: DetectContext,
  ) => StoreHandle | null;
};

/** A successful detection: which framework matched and its live handle. */
export type DetectedStore = {
  readonly framework: string;
  readonly handle: StoreHandle;
};

/**
 * Duck-typed StoreHandle guard shared by every adapter so detection-time
 * validation is defined once. `dispatch` is not required (it is optional on
 * StoreHandle); adapters that need a write surface check for it themselves.
 */
export const isStoreLike = (v: unknown): v is StoreHandle => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['getState'] === 'function' &&
    typeof r['subscribe'] === 'function'
  );
};
