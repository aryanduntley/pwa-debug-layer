import { describe, it, expect } from 'vitest';
import { getFiberForNode } from '../../src/react/get_fiber_for_node.js';
import { REACT_FIBER_KEY_PREFIX } from '../../src/react/types.js';
import type { Fiber } from '../../src/react/types.js';

const makeFiber = (overrides: Partial<Fiber> = {}): Fiber =>
  ({
    type: null,
    elementType: null,
    tag: 5,
    key: null,
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: null,
    memoizedState: null,
    ...overrides,
  }) as Fiber;

const makeEl = (props: Record<string, unknown>): Element => {
  const el = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(props)) el[k] = v;
  return el as unknown as Element;
};

describe('getFiberForNode', () => {
  it('returns undefined when element carries no __reactFiber$* key', () => {
    const el = makeEl({ id: 'plain' });
    expect(getFiberForNode(el)).toBeUndefined();
  });

  it('returns the fiber when __reactFiber$* key is present', () => {
    const fiber = makeFiber({ tag: 5, type: 'div' });
    const el = makeEl({ [`${REACT_FIBER_KEY_PREFIX}xyz`]: fiber });
    expect(getFiberForNode(el)).toBe(fiber);
  });

  it('returns undefined when the value at __reactFiber$* is null', () => {
    const el = makeEl({ [`${REACT_FIBER_KEY_PREFIX}xyz`]: null });
    expect(getFiberForNode(el)).toBeUndefined();
  });

  it('returns undefined when the value at __reactFiber$* is undefined', () => {
    const el = makeEl({ [`${REACT_FIBER_KEY_PREFIX}xyz`]: undefined });
    expect(getFiberForNode(el)).toBeUndefined();
  });

  it('returns undefined when Object.keys throws (cross-origin/foreign node)', () => {
    const el = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('SecurityError');
        },
      },
    ) as unknown as Element;
    expect(getFiberForNode(el)).toBeUndefined();
  });

  it('returns undefined when reading the value at the matched key throws', () => {
    const el = {} as Record<string, unknown>;
    const key = `${REACT_FIBER_KEY_PREFIX}xyz`;
    Object.defineProperty(el, key, {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(getFiberForNode(el as unknown as Element)).toBeUndefined();
  });

  it('ignores decoy keys that only resemble the prefix', () => {
    const fiber = makeFiber();
    const el = makeEl({
      __reactFiber: 'decoy',
      reactFiber$abc: 'decoy',
      [`${REACT_FIBER_KEY_PREFIX}real`]: fiber,
    });
    expect(getFiberForNode(el)).toBe(fiber);
  });

  it('returns the value of the first matching key when multiple exist', () => {
    const fiber1 = makeFiber({ tag: 5 });
    const fiber2 = makeFiber({ tag: 1 });
    const el = {} as Record<string, unknown>;
    el[`${REACT_FIBER_KEY_PREFIX}aaa`] = fiber1;
    el[`${REACT_FIBER_KEY_PREFIX}bbb`] = fiber2;
    expect(getFiberForNode(el as unknown as Element)).toBe(fiber1);
  });
});
