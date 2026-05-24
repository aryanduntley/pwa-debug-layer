/**
 * Redux StoreAdapter — the first adapter registered into the store registry.
 * Wraps Redux detection (explicit __pwaDebug_redux handoff + passive react-redux
 * fiber-context discovery) behind the framework-agnostic StoreAdapter contract,
 * preserving Redux's resolution order (handoff first, then discovered stores).
 *
 * Pure: detection-time reads only, delegated entirely to detectReduxStore. The
 * fiber-discovery getter is injected via DetectContext.reduxGetStores so this
 * adapter and detect.ts stay DOM-free.
 */
import type { StoreAdapter, StoreHandle, DetectContext } from '../contract.js';
import {
  detectReduxStore,
  type DetectScope,
  type ReduxGetStores,
} from './detect.js';

const detectRedux = (
  scope: unknown,
  ctx?: DetectContext,
): StoreHandle | null => {
  // ReduxStoreHandle (required dispatch) is structurally a StoreHandle; the
  // discovery genuinely yields Redux stores, so the getter cast is sound.
  const getStores = ctx?.reduxGetStores as ReduxGetStores | undefined;
  return detectReduxStore(scope as DetectScope, getStores);
};

export const reduxAdapter: StoreAdapter = Object.freeze({
  framework: 'redux',
  detect: detectRedux,
});
