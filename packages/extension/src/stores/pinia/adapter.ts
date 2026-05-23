/**
 * Pinia StoreAdapter — the third adapter registered into the store registry.
 * Wraps a detected Pinia store instance into the framework-agnostic StoreHandle
 * so the unified store_* tools work against it unchanged.
 *
 * Mapping:
 *  - getState  — store.$state (Pinia's reactive state object).
 *  - subscribe — store.$subscribe((mutation,state)=>void) adapted to the 0-arg
 *    StoreHandle contract; Pinia's $subscribe returns its own unsubscribe fn.
 *  - dispatch  — SYNTHESIZED, mirroring the Zustand adapter:
 *      { type: '$patch', payload } -> store.$patch(payload) (partial/mutator);
 *      otherwise, if store[type] is a function (a Pinia action), invoke it with
 *      the payload; otherwise throw a clear error.
 *
 * Pure: detection-time reads only (delegated to detectPiniaStore); the
 * synthesized dispatch is the sole side-effecting path.
 */
import type { StoreAdapter, StoreHandle, DetectContext } from '../contract.js';
import {
  detectPiniaStore,
  type PiniaDetectScope,
  type PiniaStore,
} from './detect.js';

type DispatchAction = { readonly type: string; readonly payload?: unknown };

const toHandle = (store: PiniaStore): StoreHandle => ({
  getState: () => store.$state,
  subscribe: (listener: () => void) => store.$subscribe(() => listener()),
  dispatch: (action: { readonly type: string }) => {
    const { type, payload } = action as DispatchAction;
    if (type === '$patch') {
      store.$patch(payload);
      return undefined;
    }
    const fn = store[type];
    if (typeof fn === 'function') {
      return (fn as (arg?: unknown) => unknown)(payload);
    }
    throw new Error(
      `pinia: no action "${type}" on the store. Use type:"$patch" with a payload to merge state, or a type matching an action method.`,
    );
  },
});

const detectPinia = (
  scope: unknown,
  ctx?: DetectContext,
): StoreHandle | null => {
  const store = detectPiniaStore(scope as PiniaDetectScope, ctx?.piniaGetStores);
  return store === null ? null : toHandle(store);
};

export const piniaAdapter: StoreAdapter = Object.freeze({
  framework: 'pinia',
  detect: detectPinia,
});
