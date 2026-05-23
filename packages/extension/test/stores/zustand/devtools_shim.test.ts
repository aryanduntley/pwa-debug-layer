import { describe, it, expect } from 'vitest';
import {
  installZustandDevtoolsShim,
  type ZustandDevtoolsShim,
} from '../../../src/stores/zustand/devtools_shim.js';
import { installReduxDevtoolsShim } from '../../../src/stores/redux/devtools_shim.js';
import { zustandAdapter } from '../../../src/stores/zustand/adapter.js';

/**
 * Faithful stand-in for zustand@5 `devtools` middleware against an arbitrary
 * scope, exercising the exact contract the shim intercepts:
 *   ext = window.__REDUX_DEVTOOLS_EXTENSION__   (skipped entirely if falsy)
 *   const connection = ext.connect(options)
 *   connection.init(get())                       // live state, incl. actions
 *   ...on every set: connection.send(action, get())
 * Returns the live vanilla store so tests can drive real state changes.
 */
type State = Record<string, unknown>;
const makeDevtoolsStore = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scope: any,
  creator: (set: (partial: unknown, action?: unknown) => void) => State,
): { getState: () => State; setState: (p: unknown) => void } => {
  let state: State = {};
  const get = (): State => state;
  const apply = (partial: unknown): void => {
    const next =
      typeof partial === 'function'
        ? (partial as (s: State) => State)(state)
        : (partial as State);
    state = { ...state, ...next };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let connection: any;
  const set = (partial: unknown, action?: unknown): void => {
    apply(partial);
    if (connection) connection.send(action ?? { type: 'anonymous' }, get());
  };
  state = creator(set);
  const ext = scope.__REDUX_DEVTOOLS_EXTENSION__;
  if (ext) {
    connection = ext.connect({ name: 'test' });
    connection.init(get());
  }
  return { getState: get, setState: apply };
};

const counter =
  (set: (partial: unknown, action?: unknown) => void): State => ({
    count: 0,
    increment: () => set((s: State) => ({ count: (s['count'] as number) + 1 })),
  });

describe('installZustandDevtoolsShim — capture', () => {
  it('captures a store at connect/init time and exposes live getState', () => {
    const scope: Record<string, unknown> = {};
    const shim = installZustandDevtoolsShim(scope);
    const store = makeDevtoolsStore(scope, counter);

    expect(shim.getStores()).toHaveLength(1);
    const captured = shim.getStores()[0]!;
    expect((captured.getState() as State)['count']).toBe(0);

    // Drive a real state change through the middleware's send path.
    (store.getState()['increment'] as () => void)();
    expect((captured.getState() as State)['count']).toBe(1);
  });

  it('named-action dispatch works through the adapter on a captured store', () => {
    const scope: Record<string, unknown> = {};
    const shim = installZustandDevtoolsShim(scope);
    makeDevtoolsStore(scope, counter);

    const handle = zustandAdapter.detect(
      {},
      { zustandShimGetStores: shim.getStores },
    );
    expect(handle).not.toBeNull();
    expect((handle!.getState() as State)['count']).toBe(0);
    handle!.dispatch!({ type: 'increment' });
    expect((handle!.getState() as State)['count']).toBe(1);
  });

  it('setState on a captured handle throws a directed degradation error', () => {
    const scope: Record<string, unknown> = {};
    const shim = installZustandDevtoolsShim(scope);
    makeDevtoolsStore(scope, counter);
    const captured = shim.getStores()[0]!;
    expect(() => captured.setState({ count: 9 })).toThrow(
      /setState is unavailable[\s\S]*__pwaDebug_zustand/,
    );
  });

  it('subscribe fires on each send and unsubscribes cleanly', () => {
    const scope: Record<string, unknown> = {};
    const shim = installZustandDevtoolsShim(scope);
    const store = makeDevtoolsStore(scope, counter);
    const captured = shim.getStores()[0]!;

    let calls = 0;
    const unsub = captured.subscribe(() => {
      calls += 1;
    });
    (store.getState()['increment'] as () => void)();
    expect(calls).toBe(1);
    unsub();
    (store.getState()['increment'] as () => void)();
    expect(calls).toBe(1);
  });
});

describe('installZustandDevtoolsShim — coexistence with the Redux shim', () => {
  it('decorates the Redux stub with .connect so Zustand apps do not throw', () => {
    const scope: Record<string, unknown> = {};
    // Redux shim installs a bare enhancer-factory function with NO .connect.
    installReduxDevtoolsShim(
      scope as Parameters<typeof installReduxDevtoolsShim>[0],
    );
    const stub = scope['__REDUX_DEVTOOLS_EXTENSION__'] as {
      connect?: unknown;
    };
    expect(typeof stub).toBe('function');
    expect(stub.connect).toBeUndefined(); // would throw under Zustand

    const shim = installZustandDevtoolsShim(scope);
    const ext = scope['__REDUX_DEVTOOLS_EXTENSION__'] as {
      connect?: unknown;
    };
    expect(typeof ext).toBe('function'); // still a Redux enhancer factory
    expect(typeof ext.connect).toBe('function'); // now Zustand-safe
    // The Redux compose hook is untouched.
    expect(typeof scope['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__']).toBe(
      'function',
    );

    // The previously-breaking Zustand path now runs and captures.
    expect(() => makeDevtoolsStore(scope, counter)).not.toThrow();
    expect(shim.getStores()).toHaveLength(1);
  });

  it('no-ops when a real .connect is already present (never clobbers devtools)', () => {
    const realConnect = (): unknown => ({
      init: () => undefined,
      send: () => undefined,
      subscribe: () => () => undefined,
      unsubscribe: () => undefined,
      error: () => undefined,
    });
    const realExt = Object.assign(() => (n: unknown) => n, {
      connect: realConnect,
    });
    const scope: Record<string, unknown> = {
      __REDUX_DEVTOOLS_EXTENSION__: realExt,
    };
    const shim = installZustandDevtoolsShim(scope);
    expect(
      (scope['__REDUX_DEVTOOLS_EXTENSION__'] as { connect: unknown }).connect,
    ).toBe(realConnect); // untouched
    expect(shim.getStores()).toEqual([]);
  });

  it('installs a benign callable carrier when no extension is present', () => {
    const scope: Record<string, unknown> = {};
    installZustandDevtoolsShim(scope);
    const ext = scope['__REDUX_DEVTOOLS_EXTENSION__'] as (() => unknown) & {
      connect: unknown;
    };
    expect(typeof ext).toBe('function');
    expect(typeof ext.connect).toBe('function');
    expect(ext()).toBeUndefined(); // carrier is a harmless no-op when called
  });

  it('is idempotent — re-install returns the same shim and shares captures', () => {
    const scope: Record<string, unknown> = {};
    const a = installZustandDevtoolsShim(scope);
    const b = installZustandDevtoolsShim(scope);
    expect(b).toBe(a);
    makeDevtoolsStore(scope, counter);
    expect(a.getStores()).toHaveLength(1);
    expect(b.getStores()).toHaveLength(1);
  });
});

// Type-only assertion that the exported shape is what page-world/page_dispatch
// bind against.
const _typecheck: ZustandDevtoolsShim = installZustandDevtoolsShim({});
void _typecheck;
