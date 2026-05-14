import { describe, it, expect } from 'vitest';
import { findReactRoots } from '../../src/react/find_react_roots.js';
import { REACT_CONTAINER_KEY_PREFIX } from '../../src/react/types.js';

type FakeEl = Element;

const makeFakeDoc = (elements: FakeEl[]): Document => {
  return {
    querySelectorAll: (selector: string): ArrayLike<FakeEl> => {
      if (selector !== '*') throw new Error(`unexpected selector ${selector}`);
      return elements;
    },
  } as unknown as Document;
};

const makeEl = (props: Record<string, unknown> = {}): FakeEl => {
  const el = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(props)) el[k] = v;
  return el as unknown as FakeEl;
};

describe('findReactRoots', () => {
  it('returns [] for an empty document', () => {
    const doc = makeFakeDoc([]);
    expect(findReactRoots(doc)).toEqual([]);
  });

  it('returns [] when no elements carry a container key', () => {
    const doc = makeFakeDoc([makeEl(), makeEl({ id: 'foo' }), makeEl({ className: 'x' })]);
    expect(findReactRoots(doc)).toEqual([]);
  });

  it('returns the one element carrying a __reactContainer$* key', () => {
    const containerEl = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}abc123`]: { tag: 3 } });
    const doc = makeFakeDoc([makeEl(), containerEl, makeEl()]);
    const result = findReactRoots(doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(containerEl);
  });

  it('returns multiple roots in document order', () => {
    const a = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}aaa`]: { tag: 3 } });
    const b = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}bbb`]: { tag: 3 } });
    const c = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}ccc`]: { tag: 3 } });
    const doc = makeFakeDoc([makeEl(), a, makeEl(), b, c]);
    const result = findReactRoots(doc);
    expect(result).toEqual([a, b, c]);
  });

  it('ignores elements whose key only resembles the prefix', () => {
    const decoy = makeEl({ __reactContainer: { tag: 3 } });
    const real = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}xyz`]: { tag: 3 } });
    const doc = makeFakeDoc([decoy, real]);
    expect(findReactRoots(doc)).toEqual([real]);
  });

  it('matches the prefix regardless of suffix content', () => {
    const a = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}`]: { tag: 3 } });
    const doc = makeFakeDoc([a]);
    expect(findReactRoots(doc)).toEqual([a]);
  });
});
