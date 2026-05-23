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

  it('falls back to getStores() when no explicit handoff is present', () => {
    const store = makeStore({ count: 9 });
    const handle = detectPiniaStore({}, () => [store]);
    expect(handle).toBe(store);
  });

  it('skips non-Pinia getStores candidates and returns the first valid one', () => {
    const store = makeStore({ count: 1 });
    const handle = detectPiniaStore({}, () => [42, { setState: () => {} }, store]);
    expect(handle).toBe(store);
  });

  it('prefers the explicit handoff over getStores', () => {
    const handoff = makeStore({ via: 'handoff' });
    const discovered = makeStore({ via: 'getStores' });
    const handle = detectPiniaStore(
      { __pwaDebug_pinia: handoff },
      () => [discovered],
    );
    expect(handle).toBe(handoff);
  });

  it('returns null when neither handoff nor getStores yields a Pinia store', () => {
    expect(detectPiniaStore({}, () => [1, 'x', null])).toBeNull();
  });
});
