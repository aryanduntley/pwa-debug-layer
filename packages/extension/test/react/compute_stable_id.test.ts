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
});
