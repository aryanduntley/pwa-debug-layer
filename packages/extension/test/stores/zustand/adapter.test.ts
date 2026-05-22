import { describe, it, expect, vi } from 'vitest';
import { zustandAdapter } from '../../../src/stores/zustand/adapter.js';
import type { ZustandVanillaStore } from '../../../src/stores/zustand/detect.js';

// Minimal Zustand-like vanilla store: state holds data + actions, setState
// merges a partial, subscribe notifies (state, prev) on every change.
const makeStore = () => {
  let state: Record<string, unknown> = {};
  const listeners = new Set<(s: unknown, p: unknown) => void>();
  const store: ZustandVanillaStore & {
    setStateRaw: (next: Record<string, unknown>) => void;
  } = {
    getState: () => state,
    setState: (partial: unknown) => {
      const prev = state;
      state = { ...state, ...(partial as Record<string, unknown>) };
      for (const l of listeners) l(state, prev);
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setStateRaw: (next) => {
      const prev = state;
      state = next;
      for (const l of listeners) l(state, prev);
    },
  };
  return store;
};

const detect = (scope: unknown) => zustandAdapter.detect(scope);

describe('zustandAdapter', () => {
  it('has the zustand framework tag', () => {
    expect(zustandAdapter.framework).toBe('zustand');
  });

  it('detect returns null without an explicit handoff', () => {
    expect(detect({})).toBeNull();
  });

  it('getState passes through to the underlying store', () => {
    const store = makeStore();
    store.setStateRaw({ count: 7 });
    const handle = detect({ __pwaDebug_zustand: store });
    expect(handle?.getState()).toEqual({ count: 7 });
  });

  it('subscribe adapts (state,prev) to a 0-arg listener and fires on change', () => {
    const store = makeStore();
    const handle = detect({ __pwaDebug_zustand: store })!;
    const listener = vi.fn();
    const unsub = handle.subscribe(listener);
    store.setState({ count: 1 });
    store.setState({ count: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    store.setState({ count: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('dispatch invokes a named action that lives in store state', () => {
    const store = makeStore();
    store.setStateRaw({
      count: 0,
      increment: () => store.setState({ count: (store.getState() as { count: number }).count + 1 }),
    });
    const handle = detect({ __pwaDebug_zustand: store })!;
    handle.dispatch?.({ type: 'increment' });
    expect((store.getState() as { count: number }).count).toBe(1);
  });

  it('dispatch passes the payload to the named action', () => {
    const store = makeStore();
    const addBy = vi.fn();
    store.setStateRaw({ addBy });
    const handle = detect({ __pwaDebug_zustand: store })!;
    handle.dispatch?.({ type: 'addBy', payload: 5 } as { type: string });
    expect(addBy).toHaveBeenCalledWith(5);
  });

  it('dispatch with type:"setState" merges a partial', () => {
    const store = makeStore();
    store.setStateRaw({ count: 1, name: 'a' });
    const handle = detect({ __pwaDebug_zustand: store })!;
    handle.dispatch?.({ type: 'setState', payload: { count: 9 } } as { type: string });
    expect(store.getState()).toEqual({ count: 9, name: 'a' });
  });

  it('dispatch throws for an unknown action that is not a state function', () => {
    const store = makeStore();
    store.setStateRaw({ count: 0 });
    const handle = detect({ __pwaDebug_zustand: store })!;
    expect(() => handle.dispatch?.({ type: 'nope' })).toThrow(/no action "nope"/);
  });
});
