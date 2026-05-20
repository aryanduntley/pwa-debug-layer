/**
 * Production page-world shim for __REDUX_DEVTOOLS_EXTENSION__ /
 * __REDUX_DEVTOOLS_EXTENSION_COMPOSE__.
 *
 * Redux store creation paths it captures:
 *  (a) `composeWithDevTools(...)` from @reduxjs/toolkit / redux-devtools-extension
 *      — calls `__REDUX_DEVTOOLS_EXTENSION_COMPOSE__(...)` then wraps the
 *      resulting enhancer over `createStore`. Our enhancer factory hands back a
 *      replacement createStore that captures every newly-created store before
 *      returning it.
 *  (b) Direct `__REDUX_DEVTOOLS_EXTENSION__(config)` — same enhancer-factory
 *      shape, returned from the function call. Captures via the same path.
 *
 * Coexistence: if the real Redux DevTools browser extension has already
 * installed its `__REDUX_DEVTOOLS_EXTENSION__` (typeof === 'function'), we
 * no-op so the user's actual devtools experience is untouched. detectReduxStore
 * still has the fixture-explicit handoff path (window.__pwaDebug_redux) as a
 * fallback when both real-devtools and our shim are skipped.
 *
 * State: install() is the only side-effecting touchpoint; all captured-store
 * state lives in the returned closure, not on the scope.
 */
import type { ReduxStoreHandle } from './detect.js';

type StoreCreator = (
  reducer: unknown,
  preloadedState?: unknown,
) => ReduxStoreHandle;

type StoreEnhancer = (next: StoreCreator) => StoreCreator;

type EnhancerFactory = (...args: readonly unknown[]) => StoreEnhancer;

type ReduxScope = {
  __REDUX_DEVTOOLS_EXTENSION__?: EnhancerFactory;
  __REDUX_DEVTOOLS_EXTENSION_COMPOSE__?: (
    ...enhancers: readonly StoreEnhancer[]
  ) => StoreEnhancer;
};

export type ReduxDevtoolsShim = {
  readonly getStores: () => readonly ReduxStoreHandle[];
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

const composeEnhancers = (
  enhancers: readonly StoreEnhancer[],
): StoreEnhancer => {
  if (enhancers.length === 0) {
    return (next) => next;
  }
  return (next) =>
    enhancers.reduceRight<StoreCreator>(
      (acc, e) => e(acc),
      next,
    );
};

export const installReduxDevtoolsShim = (
  scope: ReduxScope,
): ReduxDevtoolsShim => {
  const captured: ReduxStoreHandle[] = [];

  if (typeof scope.__REDUX_DEVTOOLS_EXTENSION__ === 'function') {
    // Real Redux DevTools extension is already present — never clobber it. The
    // fixture-explicit handoff (window.__pwaDebug_redux) remains the detection
    // path when real devtools are active.
    return Object.freeze({ getStores: () => Object.freeze([...captured]) });
  }

  const captureEnhancer: StoreEnhancer = (next) => (reducer, preloadedState) => {
    const store = next(reducer, preloadedState);
    if (isReduxLike(store)) {
      captured.push(store);
    }
    return store;
  };

  scope.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = (
    ...enhancers: readonly StoreEnhancer[]
  ): StoreEnhancer => {
    const composed = composeEnhancers([...enhancers, captureEnhancer]);
    return composed;
  };

  scope.__REDUX_DEVTOOLS_EXTENSION__ = (
    ..._args: readonly unknown[]
  ): StoreEnhancer => captureEnhancer;

  return Object.freeze({ getStores: () => Object.freeze([...captured]) });
};
