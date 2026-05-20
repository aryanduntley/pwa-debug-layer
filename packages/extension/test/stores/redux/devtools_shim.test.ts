import { describe, it, expect } from 'vitest';
import { installReduxDevtoolsShim } from '../../../src/stores/redux/devtools_shim.js';

type FakeStore = {
  getState: () => unknown;
  subscribe: (l: () => void) => () => void;
  dispatch: (a: { type: string }) => unknown;
};

const makeStore = (initial: unknown): FakeStore => ({
  getState: () => initial,
  subscribe: () => () => undefined,
  dispatch: (a) => a,
});

describe('installReduxDevtoolsShim', () => {
  it('installs both hooks on a fresh scope', () => {
    const scope: Record<string, unknown> = {};
    const shim = installReduxDevtoolsShim(scope);
    expect(typeof scope['__REDUX_DEVTOOLS_EXTENSION__']).toBe('function');
    expect(typeof scope['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__']).toBe('function');
    expect(shim.getStores()).toEqual([]);
  });

  it('no-ops when the real Redux DevTools extension is already installed', () => {
    const realCompose = () => () => () => makeStore({}); // marker
    const scope: Record<string, unknown> = {
      __REDUX_DEVTOOLS_EXTENSION__: realCompose,
    };
    const shim = installReduxDevtoolsShim(scope);
    // We must not clobber the real hook.
    expect(scope['__REDUX_DEVTOOLS_EXTENSION__']).toBe(realCompose);
    // And no compose hook is installed either.
    expect(scope['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__']).toBeUndefined();
    // Captured stores remain empty.
    expect(shim.getStores()).toEqual([]);
  });

  it('captures a store through __REDUX_DEVTOOLS_EXTENSION_COMPOSE__ (RTK path)', () => {
    const scope: Record<string, unknown> = {};
    const shim = installReduxDevtoolsShim(scope);
    const compose = scope['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'] as (
      ...e: unknown[]
    ) => (next: unknown) => (r: unknown, p?: unknown) => FakeStore;
    // Simulate Redux's createStore — our enhancer wraps it.
    const createStore = (_reducer: unknown) => makeStore({ counter: 0 });
    const enhancedCreate = compose()(createStore);
    const store = enhancedCreate(() => undefined, undefined);
    expect(store.getState()).toEqual({ counter: 0 });
    expect(shim.getStores()).toHaveLength(1);
    expect(shim.getStores()[0]).toBe(store);
  });

  it('captures a store through direct __REDUX_DEVTOOLS_EXTENSION__()', () => {
    const scope: Record<string, unknown> = {};
    const shim = installReduxDevtoolsShim(scope);
    const ext = scope['__REDUX_DEVTOOLS_EXTENSION__'] as (
      ...a: unknown[]
    ) => (next: unknown) => (r: unknown, p?: unknown) => FakeStore;
    const createStore = (_reducer: unknown) => makeStore({ v: 7 });
    const enhancedCreate = ext()(createStore);
    const store = enhancedCreate(() => undefined, undefined);
    expect(store.getState()).toEqual({ v: 7 });
    expect(shim.getStores()[0]).toBe(store);
  });

  it('captures multiple stores in creation order', () => {
    const scope: Record<string, unknown> = {};
    const shim = installReduxDevtoolsShim(scope);
    const compose = scope['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'] as (
      ...e: unknown[]
    ) => (next: unknown) => (r: unknown, p?: unknown) => FakeStore;
    const createStore = (_reducer: unknown) => makeStore({});
    const enhancedCreate = compose()(createStore);
    const s1 = enhancedCreate(() => undefined, undefined);
    const s2 = enhancedCreate(() => undefined, undefined);
    const s3 = enhancedCreate(() => undefined, undefined);
    const captured = shim.getStores();
    expect(captured).toHaveLength(3);
    expect(captured[0]).toBe(s1);
    expect(captured[1]).toBe(s2);
    expect(captured[2]).toBe(s3);
  });

  it('does not capture non-Redux-shaped return values', () => {
    const scope: Record<string, unknown> = {};
    const shim = installReduxDevtoolsShim(scope);
    const compose = scope['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'] as (
      ...e: unknown[]
    ) => (next: unknown) => (r: unknown, p?: unknown) => unknown;
    // A non-Redux-shaped object — should NOT be captured.
    const fakeCreate = (_reducer: unknown) => ({ notAStore: true });
    const enhancedCreate = compose()(fakeCreate);
    enhancedCreate(() => undefined, undefined);
    expect(shim.getStores()).toEqual([]);
  });

  it('composes enhancers in the same order as redux compose', () => {
    const scope: Record<string, unknown> = {};
    const shim = installReduxDevtoolsShim(scope);
    const compose = scope['__REDUX_DEVTOOLS_EXTENSION_COMPOSE__'] as (
      ...e: unknown[]
    ) => (next: unknown) => (r: unknown, p?: unknown) => FakeStore;

    const callLog: string[] = [];
    const mkEnhancer = (label: string) => (next: (r: unknown) => FakeStore) =>
      (reducer: unknown): FakeStore => {
        callLog.push(label);
        return next(reducer);
      };

    const createStore = (_reducer: unknown) => makeStore({});
    const enhancedCreate = compose(
      mkEnhancer('outer') as unknown,
      mkEnhancer('inner') as unknown,
    )(createStore);
    enhancedCreate(() => undefined, undefined);

    // Redux compose runs right-to-left: outer wraps inner; outer is called first.
    expect(callLog).toEqual(['outer', 'inner']);
    expect(shim.getStores()).toHaveLength(1);
  });
});
