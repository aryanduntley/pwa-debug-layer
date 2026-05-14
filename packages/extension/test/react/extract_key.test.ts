import { describe, it, expect } from 'vitest';
import { extractKey } from '../../src/react/extract_key.js';
import type { Fiber } from '../../src/react/types.js';

const f = (key: Fiber['key']): Fiber =>
  ({
    type: null,
    elementType: null,
    tag: 5,
    key,
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: null,
    memoizedState: null,
  }) as Fiber;

describe('extractKey', () => {
  it('returns undefined when key is null', () => {
    expect(extractKey(f(null))).toBeUndefined();
  });

  it('returns undefined when key is the empty string', () => {
    expect(extractKey(f(''))).toBeUndefined();
  });

  it('returns the key when set to a non-empty string', () => {
    expect(extractKey(f('abc'))).toBe('abc');
  });

  it("returns '0' when key is '0' (does not treat as falsy)", () => {
    expect(extractKey(f('0'))).toBe('0');
  });

  it('returns the key for arbitrary string values', () => {
    expect(extractKey(f('todo-42'))).toBe('todo-42');
    expect(extractKey(f('a b c'))).toBe('a b c');
  });
});
