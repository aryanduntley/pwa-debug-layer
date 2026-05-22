/**
 * Redux StoreAdapter — the first adapter registered into the store registry.
 * Wraps the existing Redux detection (detectReduxStore + the devtools-shim
 * getStores path) behind the framework-agnostic StoreAdapter contract without
 * changing Redux's resolution order (explicit __pwaDebug_redux handoff first,
 * then shim-captured stores).
 *
 * Pure: detection-time reads only, delegated entirely to detectReduxStore.
 */
import type { StoreAdapter, StoreHandle, DetectContext } from '../contract.js';
import {
  detectReduxStore,
  type DetectScope,
  type ReduxShimGetStores,
} from './detect.js';

const detectRedux = (
  scope: unknown,
  ctx?: DetectContext,
): StoreHandle | null => {
  // ReduxStoreHandle (required dispatch) is structurally a StoreHandle; the
  // shim genuinely yields Redux stores, so the getter cast is sound.
  const shim = ctx?.reduxShimGetStores as ReduxShimGetStores | undefined;
  return detectReduxStore(scope as DetectScope, shim);
};

export const reduxAdapter: StoreAdapter = Object.freeze({
  framework: 'redux',
  detect: detectRedux,
});
