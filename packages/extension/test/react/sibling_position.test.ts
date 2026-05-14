import { describe, it, expect } from 'vitest';
import { siblingPosition } from '../../src/react/sibling_position.js';
import type { Fiber } from '../../src/react/types.js';

const f = (overrides: Partial<Fiber> = {}): Fiber =>
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

const link = (parent: Fiber, children: Fiber[]): void => {
  if (children.length === 0) return;
  (parent as { child: Fiber | null }).child = children[0]!;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    (c as { return: Fiber | null }).return = parent;
    (c as { sibling: Fiber | null }).sibling = children[i + 1] ?? null;
  }
};

describe('siblingPosition', () => {
  it('returns -1 when fiber has no parent', () => {
    expect(siblingPosition(f())).toBe(-1);
  });

  it('returns 0 for the only child of a parent', () => {
    const parent = f();
    const child = f();
    link(parent, [child]);
    expect(siblingPosition(child)).toBe(0);
  });

  it('returns 0 for the first sibling', () => {
    const parent = f();
    const a = f();
    const b = f();
    const c = f();
    link(parent, [a, b, c]);
    expect(siblingPosition(a)).toBe(0);
  });

  it('returns the correct index for a middle sibling', () => {
    const parent = f();
    const a = f();
    const b = f();
    const c = f();
    link(parent, [a, b, c]);
    expect(siblingPosition(b)).toBe(1);
  });

  it('returns the correct index for the last sibling', () => {
    const parent = f();
    const a = f();
    const b = f();
    const c = f();
    link(parent, [a, b, c]);
    expect(siblingPosition(c)).toBe(2);
  });

  it("returns -1 when the parent's child chain does not include the fiber (malformed)", () => {
    const parent = f();
    const a = f();
    const orphan = f();
    link(parent, [a]);
    (orphan as { return: Fiber | null }).return = parent;
    expect(siblingPosition(orphan)).toBe(-1);
  });
});
