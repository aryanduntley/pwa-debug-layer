import { describe, it, expect } from 'vitest';
import {
  installZustandDevtoolsShim,
  type ZustandDevtoolsShim,
} from '../../../src/stores/zustand/devtools_shim.js';
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

describe('installZustandDevtoolsShim — coexistence with a pre-existing devtools callable', () => {
  it('decorates an existing bare callable with .connect so Zustand apps do not throw', () => {
    const scope: Record<string, unknown> = {};
    // Simulate some pre-existing bare __REDUX_DEVTOOLS_EXTENSION__ callable with
    // NO .connect (e.g. another tool's stub). Zustand's middleware would call
    // .connect on it and throw — the shim adds .connect to that same callable.
    scope['__REDUX_DEVTOOLS_EXTENSION__'] = () => undefined;

    const shim = installZustandDevtoolsShim(scope);
    const ext = scope['__REDUX_DEVTOOLS_EXTENSION__'] as {
      connect?: unknown;
    };
    expect(typeof ext).toBe('function'); // still the original callable
    expect(typeof ext.connect).toBe('function'); // now Zustand-safe

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

  it('installs a callable carrier returning a safe identity enhancer when no extension is present', () => {
    const scope: Record<string, unknown> = {};
    installZustandDevtoolsShim(scope);
    const ext = scope['__REDUX_DEVTOOLS_EXTENSION__'] as (() => unknown) & {
      connect: unknown;
    };
    expect(typeof ext).toBe('function');
    expect(typeof ext.connect).toBe('function');
    // Called as a Redux enhancer factory, the carrier returns an IDENTITY
    // enhancer (createStore => createStore), never undefined — so a coexisting
    // Redux app composes a clean no-op instead of crashing.
    const enhancer = ext() as (createStore: unknown) => unknown;
    expect(typeof enhancer).toBe('function');
    const createStoreStub = (): string => 'store';
    expect(enhancer(createStoreStub)).toBe(createStoreStub);
  });

  it('coexists with a legacy-pattern Redux app on the same page (no crash)', () => {
    const scope: Record<string, unknown> = {};
    installZustandDevtoolsShim(scope);
    const ext = scope['__REDUX_DEVTOOLS_EXTENSION__'] as () => unknown;

    // Emulate redux `compose(...enhancers)` (right-to-left). The old
    // `() => undefined` carrier injected `undefined` here -> 'undefined is not
    // a function'. The identity enhancer composes cleanly.
    const compose = (...fns: Array<(a: unknown) => unknown>) =>
      fns.reduce((a, b) => (x: unknown) => a(b(x)));
    const applyMiddlewareLike = (createStore: unknown): unknown => createStore;
    const createStoreStub = (): string => 'store';

    expect(() => {
      const composed = compose(
        applyMiddlewareLike,
        ext() as (a: unknown) => unknown,
      );
      const enhanced = composed(createStoreStub) as () => string;
      expect(enhanced()).toBe('store');
    }).not.toThrow();
  });

  it('never sets __REDUX_DEVTOOLS_EXTENSION_COMPOSE__ (the note-238 RTK crash global)', () => {
    const scope: Record<string, unknown> = {};
    installZustandDevtoolsShim(scope);
    expect(scope['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__']).toBeUndefined();
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
