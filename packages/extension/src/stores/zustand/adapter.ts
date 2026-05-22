/**
 * Zustand StoreAdapter — the second adapter registered into the store registry
 * (Path 4 M3). Wraps a detected Zustand vanilla store into the framework-
 * agnostic StoreHandle so the unified store_* tools work against it unchanged.
 *
 * Mapping:
 *  - getState  — passthrough.
 *  - subscribe — Zustand calls listeners with (state, prev); our StoreHandle
 *    contract is a 0-arg listener (installStoreSubscription re-reads getState),
 *    so we adapt by ignoring the args.
 *  - dispatch  — Zustand has no Redux-style dispatch. We SYNTHESIZE one:
 *      { type: 'setState', payload } -> store.setState(payload) (partial merge);
 *      otherwise, if getState()[type] is a function, invoke it with payload
 *      (the idiomatic "actions live in the store" pattern, e.g. increment());
 *      otherwise throw a clear error. This keeps store_dispatch usable for
 *      Zustand under the same allowDispatch gate as Redux.
 *
 * Pure: detection-time reads only (delegated to detectZustandStore); the
 * synthesized dispatch is the sole side-effecting path and only runs when the
 * tool is invoked.
 */
import type { StoreAdapter, StoreHandle, DetectContext } from '../contract.js';
import {
  detectZustandStore,
  type ZustandDetectScope,
  type ZustandVanillaStore,
} from './detect.js';

type DispatchAction = { readonly type: string; readonly payload?: unknown };

const toHandle = (store: ZustandVanillaStore): StoreHandle => ({
  getState: () => store.getState(),
  subscribe: (listener: () => void) => store.subscribe(() => listener()),
  dispatch: (action: { readonly type: string }) => {
    const { type, payload } = action as DispatchAction;
    if (type === 'setState') {
      store.setState(payload);
      return undefined;
    }
    const state = store.getState();
    const fn =
      state !== null && typeof state === 'object'
        ? (state as Record<string, unknown>)[type]
        : undefined;
    if (typeof fn === 'function') {
      return (fn as (arg?: unknown) => unknown)(payload);
    }
    throw new Error(
      `zustand: no action "${type}" in store state. Use type:"setState" with a payload to merge state, or a type matching a function field in the store.`,
    );
  },
});

const detectZustand = (
  scope: unknown,
  _ctx?: DetectContext,
): StoreHandle | null => {
  const store = detectZustandStore(scope as ZustandDetectScope);
  return store === null ? null : toHandle(store);
};

export const zustandAdapter: StoreAdapter = Object.freeze({
  framework: 'zustand',
  detect: detectZustand,
});
