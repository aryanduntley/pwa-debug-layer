import { describe, it, expect } from 'vitest';
import {
  detectPiniaStore,
  type PiniaStore,
} from '../../../src/stores/pinia/detect.js';

const makeStore = (state: unknown): PiniaStore =>
  ({
    $state: state,
    $patch: () => undefined,
    $subscribe: () => () => undefined,
  }) as unknown as PiniaStore;

describe('detectPiniaStore', () => {
  it('returns null when __pwaDebug_pinia is absent or not an object', () => {
    expect(detectPiniaStore({})).toBeNull();
    expect(detectPiniaStore({ __pwaDebug_pinia: 7 })).toBeNull();
    expect(detectPiniaStore({ __pwaDebug_pinia: null })).toBeNull();
  });

  it('returns the store when the candidate is duck-typed Pinia', () => {
    const handle = detectPiniaStore({ __pwaDebug_pinia: makeStore({ count: 5 }) });
    expect(handle).not.toBeNull();
    expect(handle?.$state).toEqual({ count: 5 });
  });

  it('rejects a Redux-shaped store (no $patch/$subscribe)', () => {
    const reduxLike = {
      getState: () => ({}),
      subscribe: () => () => undefined,
      dispatch: (a: { type: string }) => a,
    };
    expect(detectPiniaStore({ __pwaDebug_pinia: reduxLike })).toBeNull();
  });

  it('rejects a Zustand-shaped store (setState, no $-surface)', () => {
    const zustandLike = {
      getState: () => ({}),
      setState: () => undefined,
      subscribe: () => () => undefined,
    };
    expect(detectPiniaStore({ __pwaDebug_pinia: zustandLike })).toBeNull();
  });

  it('rejects a candidate missing $subscribe', () => {
    expect(
      detectPiniaStore({
        __pwaDebug_pinia: { $state: {}, $patch: () => undefined },
      }),
    ).toBeNull();
  });
});
