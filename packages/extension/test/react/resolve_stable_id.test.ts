import { describe, it, expect } from 'vitest';
import { computeStableId } from '../../src/react/compute_stable_id.js';
import { resolveStableId } from '../../src/react/resolve_stable_id.js';
import { REACT_FIBER_KEY_PREFIX } from '../../src/react/types.js';
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
  const type = { displayName: name };
  return f({ tag, type, key });
};

const rootElWithFiber = (fiber: Fiber): Element => {
  const el = {} as Record<string, unknown>;
  el[`${REACT_FIBER_KEY_PREFIX}xyz`] = fiber;
  return el as unknown as Element;
};

describe('resolveStableId', () => {
  it('round-trips a deeply nested fiber', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const counter = named(FUNCTION_COMPONENT_TAG, 'Counter');
    link(root, [app]);
    link(app, [counter]);
    const id = computeStableId(counter);
    expect(id).toBe('root0/App[0]/Counter[0]');
    const back = resolveStableId(id, [rootElWithFiber(root)]);
    expect(back).toBe(counter);
  });

  it('round-trips with sibling-index discrimination', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const a = named(FUNCTION_COMPONENT_TAG, 'Item');
    const b = named(FUNCTION_COMPONENT_TAG, 'Item');
    const c = named(FUNCTION_COMPONENT_TAG, 'Item');
    link(root, [app]);
    link(app, [a, b, c]);
    for (const target of [a, b, c]) {
      const id = computeStableId(target);
      expect(resolveStableId(id, [rootElWithFiber(root)])).toBe(target);
    }
  });

  it('round-trips with explicit React keys', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const list = named(FUNCTION_COMPONENT_TAG, 'TodoList');
    const t1 = named(FUNCTION_COMPONENT_TAG, 'Todo', 'todo-42');
    const t2 = named(FUNCTION_COMPONENT_TAG, 'Todo', 'todo-7');
    link(root, [list]);
    link(list, [t1, t2]);
    expect(resolveStableId(computeStableId(t1), [rootElWithFiber(root)])).toBe(t1);
    expect(resolveStableId(computeStableId(t2), [rootElWithFiber(root)])).toBe(t2);
  });

  it('round-trips host components mixed with composites', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const div = f({ tag: HOST_COMPONENT_TAG, type: 'div' });
    const span = f({ tag: HOST_COMPONENT_TAG, type: 'span' });
    link(root, [app]);
    link(app, [div]);
    link(div, [span]);
    expect(resolveStableId(computeStableId(span), [rootElWithFiber(root)])).toBe(span);
  });

  it('returns undefined when rootIndex is out of bounds', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    expect(resolveStableId('root5', [rootElWithFiber(root)])).toBeUndefined();
  });

  it("returns undefined when the head segment isn't a 'rootN'", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    expect(resolveStableId('App[0]/Counter[0]', [rootElWithFiber(root)])).toBeUndefined();
  });

  it('returns undefined when a child segment cannot be resolved', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    link(root, [app]);
    expect(resolveStableId('root0/Missing[0]', [rootElWithFiber(root)])).toBeUndefined();
  });

  it('returns undefined when a child segment is malformed (no brackets)', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    link(root, [app]);
    expect(resolveStableId('root0/App', [rootElWithFiber(root)])).toBeUndefined();
  });

  it("returns the root fiber for a bare 'rootN'", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    expect(resolveStableId('root0', [rootElWithFiber(root)])).toBe(root);
  });

  it("key segment doesn't match an index, and index segment doesn't match by key", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const list = named(FUNCTION_COMPONENT_TAG, 'List');
    const k = named(FUNCTION_COMPONENT_TAG, 'Item', 'abc');
    link(root, [list]);
    link(list, [k]);
    expect(resolveStableId('root0/List[0]/Item[0]', [rootElWithFiber(root)])).toBeUndefined();
    expect(resolveStableId('root0/List[0]/Item[abc]', [rootElWithFiber(root)])).toBe(k);
  });

  it('returns undefined when the root element carries no fiber', () => {
    const noFiberEl = {} as unknown as Element;
    expect(resolveStableId('root0', [noFiberEl])).toBeUndefined();
  });

  // SQ5 bug 2b regression — the real examples/react-pwa fixture shape.
  // Before the fix, heterogeneous unkeyed siblings got absolute-position
  // discriminators (Counter[1], TodoList[2], ...) that childAtIndex (per-name
  // occurrence) could never resolve, breaking M23 Cases D-G.
  it('round-trips heterogeneous unkeyed siblings (fixture shape)', () => {
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
    const el = rootElWithFiber(root);
    for (const target of [h1, counter, todoList, userProfile, nested]) {
      const id = computeStableId(target);
      expect(resolveStableId(id, [el])).toBe(target);
    }
  });

  // SQ5 bug 2c regression — numeric React keys. computeStableId emits li[1]/
  // li[2] (the keys); resolveStableId must try childByKey FIRST for a numeric
  // discriminator. Also covers M23 Case O (key-bearing todo identity).
  it('round-trips a numeric-keyed list — resolves by key, not index', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const ul = f({ tag: HOST_COMPONENT_TAG, type: 'ul' });
    const li1 = f({ tag: HOST_COMPONENT_TAG, type: 'li', key: '1' });
    const li2 = f({ tag: HOST_COMPONENT_TAG, type: 'li', key: '2' });
    link(root, [ul]);
    link(ul, [li1, li2]);
    const el = rootElWithFiber(root);
    expect(computeStableId(li1)).toBe('root0/ul[0]/li[1]');
    expect(resolveStableId('root0/ul[0]/li[1]', [el])).toBe(li1);
    expect(resolveStableId('root0/ul[0]/li[2]', [el])).toBe(li2);
  });

  it('numeric discriminator falls back to unkeyed occurrence when no key matches', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const ul = f({ tag: HOST_COMPONENT_TAG, type: 'ul' });
    const a = f({ tag: HOST_COMPONENT_TAG, type: 'li' });
    const b = f({ tag: HOST_COMPONENT_TAG, type: 'li' });
    link(root, [ul]);
    link(ul, [a, b]);
    const el = rootElWithFiber(root);
    expect(resolveStableId(computeStableId(a), [el])).toBe(a); // 'li[0]'
    expect(resolveStableId(computeStableId(b), [el])).toBe(b); // 'li[1]'
  });

  // Documented known limitation (note 130 / item 328): a parent with BOTH a
  // child keyed 'N' and an unkeyed same-name child at occurrence N collide on
  // 'name[N]'; childByKey wins. Not present in the fixture; full keyed/unkeyed
  // bracket-grammar redesign is a separate larger task (out of scope).
  it('documents keyed-wins ambiguity for numeric key vs unkeyed occurrence', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const ul = f({ tag: HOST_COMPONENT_TAG, type: 'ul' });
    const keyed = f({ tag: HOST_COMPONENT_TAG, type: 'li', key: '0' });
    const unkeyed = f({ tag: HOST_COMPONENT_TAG, type: 'li' });
    link(root, [ul]);
    link(ul, [keyed, unkeyed]);
    const el = rootElWithFiber(root);
    // both computeStableId -> 'root0/ul[0]/li[0]'; keyed resolves, unkeyed is shadowed
    expect(computeStableId(keyed)).toBe('root0/ul[0]/li[0]');
    expect(computeStableId(unkeyed)).toBe('root0/ul[0]/li[0]');
    expect(resolveStableId('root0/ul[0]/li[0]', [el])).toBe(keyed);
  });
});
