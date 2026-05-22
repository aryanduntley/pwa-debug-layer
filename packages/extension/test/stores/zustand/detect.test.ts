import { describe, it, expect } from 'vitest';
import {
  detectZustandStore,
  type ZustandVanillaStore,
} from '../../../src/stores/zustand/detect.js';

const makeStore = (state: unknown): ZustandVanillaStore => ({
  getState: () => state,
  setState: () => undefined,
  subscribe: () => () => undefined,
});

describe('detectZustandStore', () => {
  it('returns null when __pwaDebug_zustand is absent or not an object', () => {
    expect(detectZustandStore({})).toBeNull();
    expect(detectZustandStore({ __pwaDebug_zustand: 42 })).toBeNull();
    expect(detectZustandStore({ __pwaDebug_zustand: null })).toBeNull();
  });

  it('returns the store when the candidate is duck-typed Zustand', () => {
    const store = makeStore({ count: 3 });
    const handle = detectZustandStore({ __pwaDebug_zustand: store });
    expect(handle).not.toBeNull();
    expect(handle?.getState()).toEqual({ count: 3 });
  });

  it('rejects a Redux-shaped store (no setState)', () => {
    const reduxLike = {
      getState: () => ({}),
      subscribe: () => () => undefined,
      dispatch: (a: { type: string }) => a,
    };
    expect(detectZustandStore({ __pwaDebug_zustand: reduxLike })).toBeNull();
  });

  it('rejects a candidate missing subscribe', () => {
    expect(
      detectZustandStore({
        __pwaDebug_zustand: { getState: () => 0, setState: () => undefined },
      }),
    ).toBeNull();
  });

  it('falls back to the (reserved) shimGetStores path when handoff is absent', () => {
    const store = makeStore({ via: 'shim' });
    const handle = detectZustandStore({}, () => [store]);
    expect(handle?.getState()).toEqual({ via: 'shim' });
  });

  it('explicit handoff wins over the shim path', () => {
    const handle = detectZustandStore({ __pwaDebug_zustand: makeStore({ via: 'explicit' }) }, () => [
      makeStore({ via: 'shim' }),
    ]);
    expect(handle?.getState()).toEqual({ via: 'explicit' });
  });
});
