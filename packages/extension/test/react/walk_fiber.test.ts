import { describe, it, expect } from 'vitest';
import { walkFiber } from '../../src/react/walk_fiber.js';
import type { Fiber } from '../../src/react/types.js';

type PartialFiber = Partial<Fiber> & { name?: string };

const f = (overrides: PartialFiber): Fiber => {
  const fiber = {
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
  } as unknown as Fiber & { name?: string };
  return fiber;
};

const link = (parent: Fiber, children: Fiber[]): Fiber => {
  if (children.length === 0) return parent;
  (parent as { child: Fiber | null }).child = children[0]!;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    (c as { return: Fiber | null }).return = parent;
    (c as { sibling: Fiber | null }).sibling = children[i + 1] ?? null;
  }
  return parent;
};

const collect = (root: Fiber): Array<{ name: string; depth: number }> => {
  const out: Array<{ name: string; depth: number }> = [];
  walkFiber(root, (fiber, depth) => {
    out.push({ name: (fiber as Fiber & { name?: string }).name ?? '?', depth });
  });
  return out;
};

describe('walkFiber', () => {
  it('visits a single fiber once with depth 0', () => {
    const root = f({ name: 'R' } as PartialFiber);
    const out = collect(root);
    expect(out).toEqual([{ name: 'R', depth: 0 }]);
  });

  it('visits a linear chain in pre-order with incremented depth', () => {
    const c = f({ name: 'C' } as PartialFiber);
    const b = f({ name: 'B' } as PartialFiber);
    const a = f({ name: 'A' } as PartialFiber);
    link(b, [c]);
    link(a, [b]);
    expect(collect(a)).toEqual([
      { name: 'A', depth: 0 },
      { name: 'B', depth: 1 },
      { name: 'C', depth: 2 },
    ]);
  });

  it('visits children before siblings (pre-order DFS)', () => {
    const a = f({ name: 'A' } as PartialFiber);
    const b = f({ name: 'B' } as PartialFiber);
    const c = f({ name: 'C' } as PartialFiber);
    const d = f({ name: 'D' } as PartialFiber);
    link(b, [d]);
    link(a, [b, c]);
    expect(collect(a)).toEqual([
      { name: 'A', depth: 0 },
      { name: 'B', depth: 1 },
      { name: 'D', depth: 2 },
      { name: 'C', depth: 1 },
    ]);
  });

  it('returning false halts the current subtree but continues siblings', () => {
    const a = f({ name: 'A' } as PartialFiber);
    const b = f({ name: 'B' } as PartialFiber);
    const c = f({ name: 'C' } as PartialFiber);
    const d = f({ name: 'D' } as PartialFiber);
    link(b, [d]);
    link(a, [b, c]);
    const out: string[] = [];
    walkFiber(a, (fiber) => {
      const name = (fiber as Fiber & { name?: string }).name ?? '?';
      out.push(name);
      if (name === 'B') return false;
    });
    expect(out).toEqual(['A', 'B', 'C']);
  });

  it('returning false from the entry fiber halts entirely (no children, no top-level siblings)', () => {
    const a = f({ name: 'A' } as PartialFiber);
    const b = f({ name: 'B' } as PartialFiber);
    link(a, [b]);
    const out: string[] = [];
    walkFiber(a, (fiber) => {
      out.push((fiber as Fiber & { name?: string }).name ?? '?');
      return false;
    });
    expect(out).toEqual(['A']);
  });

  it('does NOT descend into top-level fiber siblings (entry fiber is treated as a single subtree)', () => {
    const a = f({ name: 'A' } as PartialFiber);
    const top = f({ name: 'top' } as PartialFiber);
    link(top, [a, f({ name: 'A2' } as PartialFiber)]);
    expect(collect(a).map((x) => x.name)).toEqual(['A']);
  });

  it('returning undefined or true descends normally', () => {
    const a = f({ name: 'A' } as PartialFiber);
    const b = f({ name: 'B' } as PartialFiber);
    link(a, [b]);

    const out1: string[] = [];
    walkFiber(a, (fiber) => {
      out1.push((fiber as Fiber & { name?: string }).name ?? '?');
    });
    expect(out1).toEqual(['A', 'B']);

    const out2: string[] = [];
    walkFiber(a, (fiber) => {
      out2.push((fiber as Fiber & { name?: string }).name ?? '?');
      return true;
    });
    expect(out2).toEqual(['A', 'B']);
  });

  it('handles a wide tree (many siblings) in left-to-right order', () => {
    const root = f({ name: 'R' } as PartialFiber);
    const kids = ['A', 'B', 'C', 'D', 'E'].map((n) => f({ name: n } as PartialFiber));
    link(root, kids);
    expect(collect(root).map((x) => x.name)).toEqual(['R', 'A', 'B', 'C', 'D', 'E']);
  });
});
