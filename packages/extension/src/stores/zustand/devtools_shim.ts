/**
 * Page-world Zustand devtools auto-capture shim (Path 4 M36).
 *
 * Unlike passive Redux capture (read-only react-redux fiber-context discovery):
 * Zustand's `devtools(...)` middleware does NOT use the enhancer-over-createStore
 * pattern. It reads `window.__REDUX_DEVTOOLS_EXTENSION__` and calls
 *   const connection = extensionConnector.connect(options);
 *   connection.init(initialState);                 // live state, incl. actions
 *   connection.send(action, get());                // on every setState
 *   connection.subscribe(timeTravelListener);       // for JUMP_TO_STATE etc.
 * (verified against zustand@5.0.13 middleware.js). We intercept `.connect` and
 * capture each connection's live state at init/send time, projecting it into the
 * framework-agnostic ZustandVanillaStore the adapter already understands.
 *
 * COEXISTENCE — the breakage this shim exists to prevent:
 *   If a bare `__REDUX_DEVTOOLS_EXTENSION__` callable with NO `.connect` is
 *   present (e.g. left by another tool), Zustand's middleware would call
 *   `extensionConnector.connect(...)` on a function that lacks it → TypeError,
 *   breaking the host app. So this shim DECORATES that callable with our
 *   `.connect`; when no callable is present it installs its own carrier that
 *   carries `.connect` AND, when invoked as a Redux enhancer factory, returns a
 *   safe IDENTITY enhancer (createStore => createStore) — so a coexisting
 *   legacy-pattern Redux app on the same page composes a clean no-op instead of
 *   crashing on `undefined`. If a `.connect` we did not install is already
 *   present, the real Redux DevTools extension owns the hook — we never clobber
 *   it (Zustand talks to real devtools directly; the explicit __pwaDebug_zustand
 *   handoff remains our capture path).
 *
 *   M46 AUDIT (resolved 2026-05-24): this carrier is the ONLY zero-config Zustand
 *   capture seam — a Zustand store lives in a module closure with no global and
 *   no fiber-reachable handle (the React binding only closes over the store via
 *   useSyncExternalStore), so it cannot move to passive discovery the way Redux
 *   did (whose store is a readable react-redux context value). The impersonation
 *   CRASH risk (note 238 class) was removed not by deletion but by making the
 *   carrier a spec-correct devtools stub: it returns a valid identity enhancer
 *   and never sets __REDUX_DEVTOOLS_EXTENSION_COMPOSE__.
 *
 * CAPABILITY of a captured handle: getState (latest live state, action functions
 * intact) + subscribe (fires on each send) + named-action dispatch (works,
 * because getState() exposes the in-store action functions). setState is NOT
 * supported on a devtools-captured handle — the only write channel is time-
 * travel, which round-trips through JSON and strips action functions; the handle
 * throws a clear error pointing at named actions or the __pwaDebug_zustand
 * handoff. This mirrors the honest-degradation contract of the svelte/solid
 * modules.
 *
 * State: install() is the only side-effecting touchpoint; captured stores live
 * in the returned closure, not on the scope. Idempotent — re-installing returns
 * the shim already attached to our branded `.connect`.
 */
import type { ZustandVanillaStore } from './detect.js';

/** The Redux-devtools connection surface Zustand's middleware drives. */
type DevtoolsConnection = {
  readonly init: (state: unknown) => void;
  readonly send: (action: unknown, state: unknown) => void;
  readonly subscribe: (listener: (message: unknown) => void) => () => void;
  readonly unsubscribe: () => void;
  readonly error: (message: unknown) => void;
};

type ConnectFn = (options?: unknown) => DevtoolsConnection;

/**
 * Real Redux DevTools exposes `__REDUX_DEVTOOLS_EXTENSION__` as a callable
 * (enhancer factory) that ALSO carries `.connect`. Our Redux shim installs only
 * the callable half; this shim adds `.connect`.
 */
type DevtoolsExtension = ((...args: readonly unknown[]) => unknown) & {
  connect?: ConnectFn;
};

type ZustandDevtoolsScope = {
  __REDUX_DEVTOOLS_EXTENSION__?: DevtoolsExtension;
};

export type ZustandDevtoolsShim = {
  readonly getStores: () => readonly ZustandVanillaStore[];
};

/** Brand tagging a `.connect` (and its shim) as installed by THIS module, so a
 *  pre-existing connect is recognised as real-devtools vs. our own re-install. */
const PWA_CONNECT_SHIM = Symbol.for('pwaDebug.zustandDevtoolsShim');

type BrandedConnect = ConnectFn & {
  [PWA_CONNECT_SHIM]?: ZustandDevtoolsShim;
};

export const installZustandDevtoolsShim = (
  scope: ZustandDevtoolsScope,
): ZustandDevtoolsShim => {
  const captured: ZustandVanillaStore[] = [];
  const shim: ZustandDevtoolsShim = Object.freeze({
    getStores: (): readonly ZustandVanillaStore[] =>
      Object.freeze([...captured]),
  });

  const ext = scope.__REDUX_DEVTOOLS_EXTENSION__;

  if (ext !== undefined && typeof ext.connect === 'function') {
    const prior = (ext.connect as BrandedConnect)[PWA_CONNECT_SHIM];
    // Our own connect already here → idempotent re-install; return its shim so
    // captures stay on the original array. Otherwise the real Redux DevTools
    // extension owns the hook → never clobber, capture via explicit handoff.
    return prior ?? shim;
  }

  const connect: ConnectFn = () => {
    // Zustand creates one connection per devtools-wrapped store, so each
    // connect() call corresponds to exactly one store.
    const listeners: Array<() => void> = [];
    let lastState: unknown = undefined;
    let registered = false;

    const handle: ZustandVanillaStore = {
      getState: () => lastState,
      setState: () => {
        throw new Error(
          'zustand: setState is unavailable on a store captured via the devtools ' +
            'auto-capture shim — the devtools connection is observe-only, and a write ' +
            'would have to round-trip through JSON time-travel (stripping the store\'s ' +
            'action functions). Dispatch a named in-store action instead ' +
            '(e.g. store_dispatch type:"increment"), or expose the vanilla store on ' +
            'window.__pwaDebug_zustand for full setState.',
        );
      },
      subscribe: (listener: (state: unknown, prev: unknown) => void) => {
        const wrapped = (): void => listener(lastState, lastState);
        listeners.push(wrapped);
        return () => {
          const i = listeners.indexOf(wrapped);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    };

    const record = (state: unknown): void => {
      lastState = state;
      if (!registered) {
        captured.push(handle);
        registered = true;
      }
      for (const l of [...listeners]) l();
    };

    return {
      init: (state) => record(state),
      send: (_action, state) => record(state),
      // Time-travel listener accepted and ignored — auto-capture never pushes
      // state back into the store (see handle.setState).
      subscribe: () => () => undefined,
      unsubscribe: () => undefined,
      error: () => undefined,
    };
  };
  (connect as BrandedConnect)[PWA_CONNECT_SHIM] = shim;

  if (typeof ext === 'function') {
    // Decorate the existing callable (our Redux stub) so it is BOTH an enhancer
    // factory (Redux) and a connect provider (Zustand). THE breakage fix.
    ext.connect = connect;
  } else {
    // No devtools present. Install a callable carrier that provides `.connect`
    // for Zustand. zustand@5's middleware only needs this global to be
    // truthy-with-`.connect` — it never invokes it (verified middleware.js:66) —
    // so the callable half exists purely for Redux coexistence: a legacy-pattern
    // app does `compose(applyMiddleware(...), __REDUX_DEVTOOLS_EXTENSION__())`.
    // Returning a valid IDENTITY enhancer (createStore => createStore) instead of
    // `undefined` makes that compose a clean no-op rather than crashing the host
    // app. We deliberately never set __REDUX_DEVTOOLS_EXTENSION_COMPOSE__ (the
    // wrong-contract global that crashed RTK in the deleted Redux shim, note 238).
    const carrier = (() => (createStore: unknown) =>
      createStore) as DevtoolsExtension;
    carrier.connect = connect;
    scope.__REDUX_DEVTOOLS_EXTENSION__ = carrier;
  }

  return shim;
};
