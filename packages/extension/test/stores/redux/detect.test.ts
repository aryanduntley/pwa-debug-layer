import { describe, it, expect } from 'vitest';
import { detectReduxStore } from '../../../src/stores/redux/detect.js';

describe('detectReduxStore', () => {
  it('returns null when __pwaDebug_redux is absent', () => {
    expect(detectReduxStore({})).toBeNull();
  });

  it('returns null when __pwaDebug_redux is not an object', () => {
    expect(detectReduxStore({ __pwaDebug_redux: 42 })).toBeNull();
    expect(detectReduxStore({ __pwaDebug_redux: 'store' })).toBeNull();
    expect(detectReduxStore({ __pwaDebug_redux: null })).toBeNull();
  });

  it('returns null when the candidate is missing getState/subscribe/dispatch', () => {
    expect(
      detectReduxStore({ __pwaDebug_redux: { getState: () => undefined } }),
    ).toBeNull();
    expect(
      detectReduxStore({
        __pwaDebug_redux: {
          getState: () => undefined,
          subscribe: () => () => undefined,
        },
      }),
    ).toBeNull();
  });

  it('returns null when one of the methods is not a function', () => {
    expect(
      detectReduxStore({
        __pwaDebug_redux: {
          getState: () => undefined,
          subscribe: () => () => undefined,
          dispatch: 'not-a-function',
        },
      }),
    ).toBeNull();
  });

  it('returns the typed handle when the candidate is duck-typed Redux', () => {
    let state = { counter: { value: 0 } };
    const store = {
      getState: () => state,
      subscribe: (_: () => void): (() => void) => () => undefined,
      dispatch: (a: { type: string }): { type: string } => a,
    };
    const handle = detectReduxStore({ __pwaDebug_redux: store });
    expect(handle).not.toBeNull();
    expect(handle?.getState()).toEqual({ counter: { value: 0 } });
    state = { counter: { value: 7 } };
    expect(handle?.getState()).toEqual({ counter: { value: 7 } });
  });
});

describe('detectReduxStore — shim-fallback path (M11 T2)', () => {
  const makeStore = (s: unknown) => ({
    getState: () => s,
    subscribe: (): (() => void) => () => undefined,
    dispatch: <A>(a: A): A => a,
  });

  it('falls back to shimGetStores when __pwaDebug_redux is absent', () => {
    const shimStore = makeStore({ via: 'shim' });
    const handle = detectReduxStore(
      {}, // no explicit handoff
      () => [shimStore],
    );
    expect(handle).not.toBeNull();
    expect(handle?.getState()).toEqual({ via: 'shim' });
  });

  it('returns null when both paths are empty', () => {
    expect(detectReduxStore({}, () => [])).toBeNull();
    expect(detectReduxStore({})).toBeNull();
  });

  it('explicit __pwaDebug_redux wins over shim-captured stores', () => {
    const explicit = makeStore({ via: 'explicit' });
    const shimStore = makeStore({ via: 'shim' });
    const handle = detectReduxStore(
      { __pwaDebug_redux: explicit },
      () => [shimStore],
    );
    expect(handle?.getState()).toEqual({ via: 'explicit' });
  });

  it('picks the FIRST shim-captured store when multiple are present', () => {
    const a = makeStore({ ord: 'a' });
    const b = makeStore({ ord: 'b' });
    const handle = detectReduxStore({}, () => [a, b]);
    expect(handle?.getState()).toEqual({ ord: 'a' });
  });

  it('rejects shim store that fails duck-type check', () => {
    const garbage = { not: 'a-store' } as unknown as ReturnType<typeof makeStore>;
    const handle = detectReduxStore({}, () => [garbage]);
    expect(handle).toBeNull();
  });
});
