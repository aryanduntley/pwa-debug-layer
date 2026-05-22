import { describe, it, expect } from 'vitest';
import { detectStore, STORE_ADAPTERS } from '../../src/stores/registry.js';
import { isStoreLike } from '../../src/stores/contract.js';

const makeStore = (s: unknown) => ({
  getState: () => s,
  subscribe: (): (() => void) => () => undefined,
  dispatch: <A>(a: A): A => a,
});

describe('isStoreLike', () => {
  it('accepts a store with getState + subscribe (dispatch optional)', () => {
    expect(isStoreLike({ getState: () => 0, subscribe: () => () => undefined })).toBe(true);
    expect(isStoreLike(makeStore({ a: 1 }))).toBe(true);
  });

  it('rejects non-objects and partial shapes', () => {
    expect(isStoreLike(null)).toBe(false);
    expect(isStoreLike(42)).toBe(false);
    expect(isStoreLike({ getState: () => 0 })).toBe(false);
    expect(isStoreLike({ subscribe: () => () => undefined })).toBe(false);
  });
});

describe('store registry', () => {
  it('registers the redux adapter first, then zustand', () => {
    expect(STORE_ADAPTERS.length).toBeGreaterThanOrEqual(2);
    expect(STORE_ADAPTERS[0]?.framework).toBe('redux');
    expect(STORE_ADAPTERS.map((a) => a.framework)).toContain('zustand');
  });
});

const makeZustandStore = (s: unknown) => ({
  getState: () => s,
  setState: () => undefined,
  subscribe: (): (() => void) => () => undefined,
});

describe('detectStore — zustand', () => {
  it('detects a Zustand store via its explicit handoff and tags the framework', () => {
    const detected = detectStore({
      __pwaDebug_zustand: makeZustandStore({ count: 2 }),
    });
    expect(detected?.framework).toBe('zustand');
    expect(detected?.handle.getState()).toEqual({ count: 2 });
  });

  it('redux is not claimed by zustand and vice-versa (distinct handoff keys + duck-types)', () => {
    // A redux store under the redux key -> redux; a zustand store under the
    // zustand key -> zustand; neither cross-claims.
    expect(detectStore({ __pwaDebug_redux: makeStore({ a: 1 }) })?.framework).toBe('redux');
    expect(
      detectStore({ __pwaDebug_zustand: makeZustandStore({ a: 1 }) })?.framework,
    ).toBe('zustand');
  });

  it('honors an explicit zustand framework selector', () => {
    const scope = { __pwaDebug_zustand: makeZustandStore({ a: 1 }) };
    expect(detectStore(scope, undefined, 'zustand')?.framework).toBe('zustand');
    expect(detectStore(scope, undefined, 'redux')).toBeNull();
  });
});

const makePiniaStore = (state: unknown) => ({
  $state: state,
  $patch: () => undefined,
  $subscribe: (): (() => void) => () => undefined,
});

describe('detectStore — pinia', () => {
  it('detects a Pinia store via its explicit handoff and tags the framework', () => {
    const detected = detectStore({ __pwaDebug_pinia: makePiniaStore({ count: 4 }) });
    expect(detected?.framework).toBe('pinia');
    expect(detected?.handle.getState()).toEqual({ count: 4 });
  });

  it('does not cross-claim across redux/zustand/pinia', () => {
    expect(detectStore({ __pwaDebug_redux: makeStore({ a: 1 }) })?.framework).toBe('redux');
    expect(detectStore({ __pwaDebug_zustand: makeZustandStore({ a: 1 }) })?.framework).toBe('zustand');
    expect(detectStore({ __pwaDebug_pinia: makePiniaStore({ a: 1 }) })?.framework).toBe('pinia');
  });
});

const jotaiAtom = { id: 'count' };
const makeJotaiHandoff = () => ({
  store: {
    get: () => 0,
    set: () => undefined,
    sub: (): (() => void) => () => undefined,
  },
  atoms: { count: jotaiAtom },
});

describe('detectStore — jotai', () => {
  it('detects a Jotai handoff and tags the framework', () => {
    const detected = detectStore({ __pwaDebug_jotai: makeJotaiHandoff() });
    expect(detected?.framework).toBe('jotai');
    expect(detected?.handle.getState()).toEqual({ count: 0 });
  });

  it('all four adapters are registered in priority order', () => {
    expect(STORE_ADAPTERS.map((a) => a.framework)).toEqual([
      'redux',
      'zustand',
      'pinia',
      'jotai',
    ]);
  });
});

describe('detectStore', () => {
  it('returns null when no registered adapter matches', () => {
    expect(detectStore({})).toBeNull();
  });

  it('detects a Redux store via explicit handoff and tags the framework', () => {
    const store = makeStore({ counter: { value: 3 } });
    const detected = detectStore({ __pwaDebug_redux: store });
    expect(detected).not.toBeNull();
    expect(detected?.framework).toBe('redux');
    expect(detected?.handle.getState()).toEqual({ counter: { value: 3 } });
  });

  it('detects a Redux store via the shim getStores DetectContext path', () => {
    const store = makeStore({ via: 'shim' });
    const detected = detectStore({}, { reduxShimGetStores: () => [store] });
    expect(detected?.framework).toBe('redux');
    expect(detected?.handle.getState()).toEqual({ via: 'shim' });
  });

  it('explicit handoff wins over the shim path', () => {
    const detected = detectStore(
      { __pwaDebug_redux: makeStore({ via: 'explicit' }) },
      { reduxShimGetStores: () => [makeStore({ via: 'shim' })] },
    );
    expect(detected?.handle.getState()).toEqual({ via: 'explicit' });
  });

  it('honors an explicit framework selector', () => {
    const store = makeStore({ a: 1 });
    expect(detectStore({ __pwaDebug_redux: store }, undefined, 'redux')?.framework).toBe('redux');
    // Unknown framework tag consults no adapter.
    expect(detectStore({ __pwaDebug_redux: store }, undefined, 'zustand')).toBeNull();
  });
});
