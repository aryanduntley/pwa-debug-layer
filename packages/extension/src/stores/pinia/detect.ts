/**
 * Page-world Pinia store detection — explicit-handoff path
 * (window.__pwaDebug_pinia), mirroring the Redux/Zustand contract.
 *
 * Pinia stores are Vue-app-scoped; the handoff exposes a single store instance
 * (or the most relevant one). Detection resolves the explicit handoff first,
 * then falls back to an optional `getStores` provider (M37 auto-discovery:
 * stores pulled off the live Vue app's config.globalProperties.$pinia registry
 * — see ./discover). The provider is threaded in via the framework-agnostic
 * DetectContext so this module stays DOM-free.
 *
 * Disambiguation: a Pinia store exposes the $-prefixed surface $state/$patch/
 * $subscribe — distinct from Redux (dispatch) and Zustand (setState) — and uses
 * its own handoff key, so no adapter cross-claims another's store.
 *
 * Pure: no DOM, no chrome.* — duck-typed reads only.
 */

/** The minimal Pinia store-instance surface this module needs. */
export type PiniaStore = {
  readonly $state: unknown;
  readonly $patch: (partialOrMutator: unknown) => void;
  readonly $subscribe: (
    callback: (mutation: unknown, state: unknown) => void,
    options?: unknown,
  ) => () => void;
  // Actions/getters are accessed dynamically by name via the synthesized
  // dispatch, so they are not part of the static contract.
  readonly [key: string]: unknown;
};

/** Scope shape — only the property name we read is part of the contract. */
export type PiniaDetectScope = {
  readonly __pwaDebug_pinia?: unknown;
};

/**
 * Auto-discovery provider: yields raw store candidates found off the live Vue
 * app (see ./discover). Returns `unknown[]` because the contract seam is
 * framework-neutral; detectPiniaStore validates each via isPiniaLike.
 */
export type PiniaGetStores = () => readonly unknown[];

/** Duck-type guard for the minimal Pinia store surface ($state/$patch/$subscribe). */
export const isPiniaLike = (v: unknown): v is PiniaStore => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    '$state' in r &&
    typeof r['$patch'] === 'function' &&
    typeof r['$subscribe'] === 'function'
  );
};

/**
 * Find the active Pinia store. Resolution order:
 *  1. scope.__pwaDebug_pinia (explicit handoff — wins when present).
 *  2. getStores()[first Pinia-shaped] (M37 auto-discovery; absent provider means
 *     "no auto-discovery wired").
 * Returns null when neither yields a Pinia-shaped store.
 */
export const detectPiniaStore = (
  scope: PiniaDetectScope,
  getStores?: PiniaGetStores,
): PiniaStore | null => {
  const candidate = scope.__pwaDebug_pinia;
  if (candidate !== undefined && isPiniaLike(candidate)) return candidate;
  if (getStores !== undefined) {
    for (const s of getStores()) {
      if (isPiniaLike(s)) return s;
    }
  }
  return null;
};
