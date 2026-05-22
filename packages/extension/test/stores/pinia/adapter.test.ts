import { describe, it, expect, vi } from 'vitest';
import { piniaAdapter } from '../../../src/stores/pinia/adapter.js';
import type { PiniaStore } from '../../../src/stores/pinia/detect.js';

// Minimal Pinia-like store: $state object, $patch merges (object) or runs a
// mutator (fn), $subscribe notifies (mutation,state), actions live on the store.
const makeStore = () => {
  let state: Record<string, unknown> = { count: 0 };
  const listeners = new Set<(m: unknown, s: unknown) => void>();
  const notify = () => {
    for (const l of listeners) l({ type: 'patch' }, state);
  };
  const store = {
    $state: state,
    $patch: (partialOrMutator: unknown) => {
      if (typeof partialOrMutator === 'function') {
        (partialOrMutator as (s: Record<string, unknown>) => void)(state);
      } else {
        state = { ...state, ...(partialOrMutator as Record<string, unknown>) };
        store.$state = state;
      }
      notify();
    },
    $subscribe: (cb: (m: unknown, s: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    increment(this: { $state: Record<string, unknown> }) {
      state = { ...state, count: (state['count'] as number) + 1 };
      store.$state = state;
      notify();
    },
  } as unknown as PiniaStore & { increment: () => void };
  return store;
};

const detect = (scope: unknown) => piniaAdapter.detect(scope);

describe('piniaAdapter', () => {
  it('has the pinia framework tag', () => {
    expect(piniaAdapter.framework).toBe('pinia');
  });

  it('detect returns null without a handoff', () => {
    expect(detect({})).toBeNull();
  });

  it('getState reads $state', () => {
    const store = makeStore();
    const handle = detect({ __pwaDebug_pinia: store })!;
    expect(handle.getState()).toEqual({ count: 0 });
  });

  it('subscribe adapts $subscribe to a 0-arg listener and fires on change', () => {
    const store = makeStore();
    const handle = detect({ __pwaDebug_pinia: store })!;
    const listener = vi.fn();
    const unsub = handle.subscribe(listener);
    store.$patch({ count: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    store.$patch({ count: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispatch type:"$patch" merges a partial', () => {
    const store = makeStore();
    const handle = detect({ __pwaDebug_pinia: store })!;
    handle.dispatch?.({ type: '$patch', payload: { count: 9 } } as { type: string });
    expect(handle.getState()).toEqual({ count: 9 });
  });

  it('dispatch invokes a named action on the store', () => {
    const store = makeStore();
    const handle = detect({ __pwaDebug_pinia: store })!;
    handle.dispatch?.({ type: 'increment' });
    expect((handle.getState() as { count: number }).count).toBe(1);
  });

  it('dispatch throws for an unknown action', () => {
    const store = makeStore();
    const handle = detect({ __pwaDebug_pinia: store })!;
    expect(() => handle.dispatch?.({ type: 'nope' })).toThrow(/no action "nope"/);
  });
});
