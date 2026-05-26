import { describe, it, expect, vi } from 'vitest';
import { jotaiAdapter } from '../../../src/stores/jotai/adapter.js';

// Mock Jotai store keyed by opaque atom identities, with per-atom subscribers.
const makeJotai = () => {
  const values = new Map<unknown, unknown>();
  const subs = new Map<unknown, Set<() => void>>();
  const store = {
    get: (atom: unknown) => values.get(atom),
    set: (atom: unknown, value: unknown) => {
      values.set(atom, value);
      subs.get(atom)?.forEach((l) => l());
    },
    sub: (atom: unknown, listener: () => void) => {
      if (!subs.has(atom)) subs.set(atom, new Set());
      subs.get(atom)!.add(listener);
      return () => subs.get(atom)!.delete(listener);
    },
  };
  return { store, values };
};

const countAtom = { id: 'count' };
const nameAtom = { id: 'name' };

const makeHandoff = () => {
  const { store, values } = makeJotai();
  values.set(countAtom, 0);
  values.set(nameAtom, 'a');
  return { __pwaDebug_jotai: { store, atoms: { count: countAtom, name: nameAtom } } };
};

const detect = (scope: unknown) => jotaiAdapter.detect(scope);

describe('jotaiAdapter', () => {
  it('has the jotai framework tag', () => {
    expect(jotaiAdapter.framework).toBe('jotai');
  });

  it('detect returns null without a handoff', () => {
    expect(detect({})).toBeNull();
  });

  it('getState builds a name-keyed snapshot over the exposed atoms', () => {
    const handle = detect(makeHandoff())!;
    expect(handle.getState()).toEqual({ count: 0, name: 'a' });
  });

  it('subscribe fires the 0-arg listener when any named atom changes', () => {
    const scope = makeHandoff();
    const handle = detect(scope)!;
    const listener = vi.fn();
    const unsub = handle.subscribe(listener);
    scope.__pwaDebug_jotai.store.set(countAtom, 1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    scope.__pwaDebug_jotai.store.set(countAtom, 2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispatch sets an atom by name', () => {
    const handle = detect(makeHandoff())!;
    handle.dispatch?.({ type: 'count', payload: 9 } as { type: string });
    expect((handle.getState() as { count: number }).count).toBe(9);
  });

  it('dispatch throws for an unknown atom name', () => {
    const handle = detect(makeHandoff())!;
    expect(() => handle.dispatch?.({ type: 'nope' })).toThrow(/no atom named "nope"/);
  });

  // M44: zero-handoff discovery via the DetectContext.jotaiGetStores seam — a
  // bare store found on a React context is turned into a { store, atoms } handoff
  // by enumerating its dev-mounted atoms.
  const makeDevStore = () => {
    const { store, values } = makeJotai();
    const countAtom = { debugLabel: 'count' };
    values.set(countAtom, 7);
    return { ...store, dev4_get_mounted_atoms: () => [countAtom][Symbol.iterator]() };
  };

  it('detects a bare store via jotaiGetStores when no explicit handoff exists', () => {
    const devStore = makeDevStore();
    const handle = jotaiAdapter.detect({}, { jotaiGetStores: () => [devStore] })!;
    expect(handle).not.toBeNull();
    expect(handle.getState()).toEqual({ count: 7 });
  });

  it('prefers the explicit handoff over the discovery seam', () => {
    const scope = makeHandoff();
    const devStore = makeDevStore();
    const handle = jotaiAdapter.detect(scope, { jotaiGetStores: () => [devStore] })!;
    // Explicit handoff exposes count+name; the dev store would expose only count.
    expect(handle.getState()).toEqual({ count: 0, name: 'a' });
  });

  it('returns null when the seam yields no dev-introspectable store', () => {
    const { store } = makeJotai(); // bare store, no dev API
    expect(jotaiAdapter.detect({}, { jotaiGetStores: () => [store] })).toBeNull();
  });
});
