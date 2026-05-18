import { describe, it, expect } from 'vitest';
import { computeStableId } from '../../src/react/compute_stable_id.js';
import type { Fiber } from '../../src/react/types.js';

const HOST_ROOT_TAG = 3;
const HOST_COMPONENT_TAG = 5;
const FUNCTION_COMPONENT_TAG = 0;

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

const named = (tag: number, name: string, key: string | null = null): Fiber => {
  const fn = { displayName: name };
  return f({ tag, type: fn, key });
};

describe('computeStableId', () => {
  it('returns just the root segment for a HostRoot fiber', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    expect(computeStableId(root)).toBe('root0');
  });

  it("uses the supplied rootIndex in the 'rootN' segment", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    expect(computeStableId(root, 2)).toBe('root2');
  });

  it('produces root0/App[0] for an only child App under HostRoot', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    link(root, [app]);
    expect(computeStableId(app)).toBe('root0/App[0]');
  });

  it('produces root0/App[0]/Counter[0] for a nested counter', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const counter = named(FUNCTION_COMPONENT_TAG, 'Counter');
    link(root, [app]);
    link(app, [counter]);
    expect(computeStableId(counter)).toBe('root0/App[0]/Counter[0]');
  });

  it('uses sibling index when keys are absent', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const a = named(FUNCTION_COMPONENT_TAG, 'Item');
    const b = named(FUNCTION_COMPONENT_TAG, 'Item');
    const c = named(FUNCTION_COMPONENT_TAG, 'Item');
    link(root, [app]);
    link(app, [a, b, c]);
    expect(computeStableId(a)).toBe('root0/App[0]/Item[0]');
    expect(computeStableId(b)).toBe('root0/App[0]/Item[1]');
    expect(computeStableId(c)).toBe('root0/App[0]/Item[2]');
  });

  it('uses key when present (overrides index)', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const list = named(FUNCTION_COMPONENT_TAG, 'TodoList');
    const t1 = named(FUNCTION_COMPONENT_TAG, 'Todo', 'todo-42');
    const t2 = named(FUNCTION_COMPONENT_TAG, 'Todo', 'todo-7');
    link(root, [list]);
    link(list, [t1, t2]);
    expect(computeStableId(t1)).toBe('root0/TodoList[0]/Todo[todo-42]');
    expect(computeStableId(t2)).toBe('root0/TodoList[0]/Todo[todo-7]');
  });

  it('mixes host components and composites in the path', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const div = f({ tag: HOST_COMPONENT_TAG, type: 'div' });
    const span = f({ tag: HOST_COMPONENT_TAG, type: 'span' });
    link(root, [app]);
    link(app, [div]);
    link(div, [span]);
    expect(computeStableId(span)).toBe('root0/App[0]/div[0]/span[0]');
  });

  it('is stable across prop changes (same tree shape, different memoizedProps)', () => {
    const make = (counterValue: number): Fiber => {
      const root = f({ tag: HOST_ROOT_TAG });
      const app = named(FUNCTION_COMPONENT_TAG, 'App');
      const counter = named(FUNCTION_COMPONENT_TAG, 'Counter');
      (counter as { memoizedProps: unknown }).memoizedProps = { count: counterValue };
      link(root, [app]);
      link(app, [counter]);
      return counter;
    };
    expect(computeStableId(make(0))).toBe(computeStableId(make(99)));
  });

  it("HostRoot ancestor still becomes 'rootN' even if there are non-root tags above (none expected)", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    link(root, [app]);
    expect(computeStableId(app, 5)).toBe('root5/App[0]');
  });

  // SQ5 bug 2b regression: heterogeneous unkeyed siblings (the real
  // examples/react-pwa fixture shape). Old absolute-siblingPosition produced
  // Counter[1]/TodoList[2]/... which resolveStableId could never resolve.
  // Per-name unkeyed occurrence gives each a [0] discriminator.
  it('heterogeneous unkeyed siblings each get per-name occurrence [0]', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const div = f({ tag: HOST_COMPONENT_TAG, type: 'div' });
    const h1 = f({ tag: HOST_COMPONENT_TAG, type: 'h1' });
    const counter = named(FUNCTION_COMPONENT_TAG, 'Counter');
    const todoList = named(FUNCTION_COMPONENT_TAG, 'TodoList');
    const userProfile = named(FUNCTION_COMPONENT_TAG, 'UserProfile');
    const nested = named(FUNCTION_COMPONENT_TAG, 'NestedSection');
    link(root, [app]);
    link(app, [div]);
    link(div, [h1, counter, todoList, userProfile, nested]);
    expect(computeStableId(h1)).toBe('root0/App[0]/div[0]/h1[0]');
    expect(computeStableId(counter)).toBe('root0/App[0]/div[0]/Counter[0]');
    expect(computeStableId(todoList)).toBe('root0/App[0]/div[0]/TodoList[0]');
    expect(computeStableId(userProfile)).toBe('root0/App[0]/div[0]/UserProfile[0]');
    expect(computeStableId(nested)).toBe('root0/App[0]/div[0]/NestedSection[0]');
  });

  it('same-name unkeyed siblings still increment per-name occurrence', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const ul = f({ tag: HOST_COMPONENT_TAG, type: 'ul' });
    const a = f({ tag: HOST_COMPONENT_TAG, type: 'li' });
    const heading = f({ tag: HOST_COMPONENT_TAG, type: 'h2' });
    const b = f({ tag: HOST_COMPONENT_TAG, type: 'li' });
    link(root, [ul]);
    link(ul, [a, heading, b]);
    // heading between the two li's must not shift the second li off [1]
    expect(computeStableId(a)).toBe('root0/ul[0]/li[0]');
    expect(computeStableId(b)).toBe('root0/ul[0]/li[1]');
    expect(computeStableId(heading)).toBe('root0/ul[0]/h2[0]');
  });

  // SQ5 bug 2c regression: numeric React keys (<li key={1}>) must be emitted
  // as the key itself, not mistaken for an occurrence index.
  it('numeric React keys are emitted as the key, not an occurrence index', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const ul = f({ tag: HOST_COMPONENT_TAG, type: 'ul' });
    const li1 = f({ tag: HOST_COMPONENT_TAG, type: 'li', key: '1' });
    const li2 = f({ tag: HOST_COMPONENT_TAG, type: 'li', key: '2' });
    link(root, [ul]);
    link(ul, [li1, li2]);
    expect(computeStableId(li1)).toBe('root0/ul[0]/li[1]');
    expect(computeStableId(li2)).toBe('root0/ul[0]/li[2]');
  });
});
