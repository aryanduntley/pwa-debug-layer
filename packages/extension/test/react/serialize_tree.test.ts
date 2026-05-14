import { describe, it, expect } from 'vitest';
import { serializeTree } from '../../src/react/serialize_tree.js';
import { computeStableId } from '../../src/react/compute_stable_id.js';
import { REACT_CONTAINER_KEY_PREFIX } from '../../src/react/types.js';
import type { Fiber } from '../../src/react/types.js';

const HOST_ROOT_TAG = 3;
const FUNCTION_COMPONENT_TAG = 0;
const CLASS_COMPONENT_TAG = 1;
const HOST_COMPONENT_TAG = 5;

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

const named = (tag: number, name: string): Fiber => f({ tag, type: { displayName: name } });

const containerEl = (root: Fiber): Element => {
  const el = {} as Record<string, unknown>;
  el[`${REACT_CONTAINER_KEY_PREFIX}abc`] = { current: root };
  return el as unknown as Element;
};

const docOf = (containers: Element[]): Document => {
  return {
    querySelectorAll: (sel: string) => {
      if (sel !== '*') throw new Error(`unexpected selector ${sel}`);
      return containers;
    },
  } as unknown as Document;
};

describe('serializeTree', () => {
  it('returns rootCount=0 + no roots when document has no React roots', () => {
    const result = serializeTree(docOf([]));
    expect(result).toEqual({ roots: [], truncated: false, rootCount: 0 });
  });

  it('serializes a single root with one composite child', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    link(root, [app]);

    const result = serializeTree(docOf([containerEl(root)]));
    expect(result.rootCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.roots).toHaveLength(1);

    const rootNode = result.roots[0]!;
    expect(rootNode.displayName).toBe('HostRoot');
    expect(rootNode.stableId).toBe(computeStableId(root, 0));
    expect(rootNode.hasState).toBe(false);
    expect(rootNode.hasHooks).toBe(false);
    expect(rootNode.children).toHaveLength(1);

    const appNode = rootNode.children[0]!;
    expect(appNode.displayName).toBe('App');
    expect(appNode.stableId).toBe(computeStableId(app, 0));
  });

  it('returns rootCount across all roots and serializes all by default', () => {
    const r1 = f({ tag: HOST_ROOT_TAG });
    const r2 = f({ tag: HOST_ROOT_TAG });
    const result = serializeTree(docOf([containerEl(r1), containerEl(r2)]));
    expect(result.rootCount).toBe(2);
    expect(result.roots).toHaveLength(2);
  });

  it('rootIndex filters to that single root', () => {
    const r1 = f({ tag: HOST_ROOT_TAG });
    const r2 = f({ tag: HOST_ROOT_TAG });
    const app2 = named(FUNCTION_COMPONENT_TAG, 'App2');
    link(r2, [app2]);

    const result = serializeTree(docOf([containerEl(r1), containerEl(r2)]), {
      rootIndex: 1,
    });
    expect(result.rootCount).toBe(2);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]!.children[0]!.displayName).toBe('App2');
    expect(result.roots[0]!.stableId.startsWith('root1')).toBe(true);
  });

  it('rootIndex out of range returns empty roots and unchanged rootCount', () => {
    const r1 = f({ tag: HOST_ROOT_TAG });
    const result = serializeTree(docOf([containerEl(r1)]), { rootIndex: 99 });
    expect(result.rootCount).toBe(1);
    expect(result.roots).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('depthLimit prunes grandchildren and marks truncated', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const counter = named(FUNCTION_COMPONENT_TAG, 'Counter');
    link(root, [app]);
    link(app, [counter]);

    const result = serializeTree(docOf([containerEl(root)]), { depthLimit: 1 });
    expect(result.truncated).toBe(true);
    expect(result.roots[0]!.children[0]!.displayName).toBe('App');
    expect(result.roots[0]!.children[0]!.children).toEqual([]);
  });

  it('maxNodes caps total emission and marks truncated', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = named(FUNCTION_COMPONENT_TAG, 'App');
    const a = named(FUNCTION_COMPONENT_TAG, 'A');
    const b = named(FUNCTION_COMPONENT_TAG, 'B');
    const c = named(FUNCTION_COMPONENT_TAG, 'C');
    link(root, [app]);
    link(app, [a, b, c]);

    const result = serializeTree(docOf([containerEl(root)]), { maxNodes: 3 });
    expect(result.truncated).toBe(true);
    const flatten = (node: { children: { displayName: string }[]; displayName: string }): string[] => {
      const names: string[] = [node.displayName];
      for (const child of node.children) names.push(...flatten(child as any));
      return names;
    };
    expect(flatten(result.roots[0]!).length).toBeLessThanOrEqual(3);
  });

  it('hasHooks is true for function components with non-null memoizedState', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const counter = f({
      tag: FUNCTION_COMPONENT_TAG,
      type: { displayName: 'Counter' },
      memoizedState: { state: 0, next: null },
    });
    link(root, [counter]);

    const result = serializeTree(docOf([containerEl(root)]));
    const counterNode = result.roots[0]!.children[0]!;
    expect(counterNode.hasHooks).toBe(true);
    expect(counterNode.hasState).toBe(false);
  });

  it('hasState is true for class components with non-null memoizedState', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = f({
      tag: CLASS_COMPONENT_TAG,
      type: { displayName: 'App' },
      memoizedState: { count: 0 },
    });
    link(root, [app]);

    const result = serializeTree(docOf([containerEl(root)]));
    const appNode = result.roots[0]!.children[0]!;
    expect(appNode.hasState).toBe(true);
    expect(appNode.hasHooks).toBe(false);
  });

  it('host components have hasState:false hasHooks:false', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const div = f({ tag: HOST_COMPONENT_TAG, type: 'div' });
    link(root, [div]);

    const result = serializeTree(docOf([containerEl(root)]));
    const divNode = result.roots[0]!.children[0]!;
    expect(divNode.displayName).toBe('div');
    expect(divNode.hasState).toBe(false);
    expect(divNode.hasHooks).toBe(false);
  });

  it('includes key field only when fiber has a non-empty key', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const list = named(FUNCTION_COMPONENT_TAG, 'TodoList');
    const t1 = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'Todo' }, key: 'todo-42' });
    const t2 = named(FUNCTION_COMPONENT_TAG, 'Todo');
    link(root, [list]);
    link(list, [t1, t2]);

    const result = serializeTree(docOf([containerEl(root)]));
    const listNode = result.roots[0]!.children[0]!;
    expect(listNode.children[0]!.key).toBe('todo-42');
    expect('key' in listNode.children[1]!).toBe(false);
  });

  it('skips a root whose container resolves to no fiber', () => {
    const decoyEl = {} as unknown as Element;
    Object.defineProperty(decoyEl, `${REACT_CONTAINER_KEY_PREFIX}x`, {
      enumerable: true,
      value: null,
    });
    const root2 = f({ tag: HOST_ROOT_TAG });

    const result = serializeTree(docOf([decoyEl, containerEl(root2)]));
    expect(result.rootCount).toBe(2);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]!.stableId.startsWith('root1')).toBe(true);
  });
});
