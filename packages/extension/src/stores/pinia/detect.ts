/**
 * Page-world Pinia store detection — explicit-handoff path
 * (window.__pwaDebug_pinia), mirroring the Redux/Zustand contract.
 *
 * Pinia stores are Vue-app-scoped; the handoff exposes a single store instance
 * (or the most relevant one). Detection is explicit-handoff only for now — a
 * Vue-devtools / getActivePinia() auto-discovery path is a future follow-on
 * (and overlaps Path 5 Vue introspection).
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

const isPiniaLike = (v: unknown): v is PiniaStore => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    '$state' in r &&
    typeof r['$patch'] === 'function' &&
    typeof r['$subscribe'] === 'function'
  );
};

/**
 * Find the active Pinia store via the scope.__pwaDebug_pinia explicit handoff.
 * Returns null when absent or not a Pinia-shaped store.
 */
export const detectPiniaStore = (
  scope: PiniaDetectScope,
): PiniaStore | null => {
  const candidate = scope.__pwaDebug_pinia;
  if (candidate !== undefined && isPiniaLike(candidate)) return candidate;
  return null;
};
