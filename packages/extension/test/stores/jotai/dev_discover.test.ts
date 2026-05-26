import { describe, it, expect } from 'vitest';
import { buildHandoffFromDevStore } from '../../../src/stores/jotai/dev_discover.js';

// A bare Jotai store ({ get, set, sub }) plus the version-specific dev iterator.
// `apiVersion` selects which mounted-atoms accessor name to expose so we cover
// both jotai >=2.6 (dev4_) and 2.0–2.5 (dev_).
const makeDevStore = (
  atoms: unknown[],
  apiVersion: 'dev4' | 'dev' | 'none',
) => {
  const values = new Map<unknown, unknown>();
  const base = {
    get: (atom: unknown) => values.get(atom),
    set: (atom: unknown, value: unknown) => values.set(atom, value),
    sub: () => () => undefined,
  };
  const iter = () => atoms[Symbol.iterator]();
  if (apiVersion === 'dev4') return { ...base, dev4_get_mounted_atoms: iter };
  if (apiVersion === 'dev') return { ...base, dev_get_mounted_atoms: iter };
  return base;
};

describe('buildHandoffFromDevStore', () => {
  it('returns null for a non-Jotai candidate', () => {
    expect(buildHandoffFromDevStore({ getState: () => ({}) })).toBeNull();
    expect(buildHandoffFromDevStore(null)).toBeNull();
    expect(buildHandoffFromDevStore(42)).toBeNull();
  });

  it('returns null for a Jotai store with no dev API (production build)', () => {
    const store = makeDevStore([], 'none');
    expect(buildHandoffFromDevStore(store)).toBeNull();
  });

  it('keys atoms by debugLabel via the dev4_ (jotai >=2.6) accessor', () => {
    const countAtom = { debugLabel: 'count' };
    const nameAtom = { debugLabel: 'name' };
    const store = makeDevStore([countAtom, nameAtom], 'dev4');
    const handoff = buildHandoffFromDevStore(store)!;
    expect(handoff).not.toBeNull();
    expect(handoff.atoms).toEqual({ count: countAtom, name: nameAtom });
    expect(handoff.store).toBe(store);
  });

  it('reads through the dev_ (jotai 2.0–2.5) accessor too', () => {
    const a = { debugLabel: 'a' };
    const store = makeDevStore([a], 'dev');
    const handoff = buildHandoffFromDevStore(store)!;
    expect(handoff.atoms).toEqual({ a });
  });

  it('synthesizes atom{index} names for unlabeled atoms', () => {
    const a = {};
    const b = { debugLabel: 'named' };
    const c = {};
    const store = makeDevStore([a, b, c], 'dev4');
    const handoff = buildHandoffFromDevStore(store)!;
    expect(handoff.atoms).toEqual({ atom0: a, named: b, atom2: c });
  });

  it('falls back to a synthesized name when debugLabels collide', () => {
    const a = { debugLabel: 'dup' };
    const b = { debugLabel: 'dup' };
    const store = makeDevStore([a, b], 'dev4');
    const handoff = buildHandoffFromDevStore(store)!;
    // First "dup" keeps the label; the colliding second is addressable as atom1.
    expect(handoff.atoms).toEqual({ dup: a, atom1: b });
  });

  it('returns an empty atoms registry for a dev store with nothing mounted', () => {
    const store = makeDevStore([], 'dev4');
    const handoff = buildHandoffFromDevStore(store)!;
    expect(handoff).not.toBeNull();
    expect(handoff.atoms).toEqual({});
  });
});
