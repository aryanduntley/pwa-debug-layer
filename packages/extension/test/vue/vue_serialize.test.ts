import { describe, it, expect } from 'vitest';
import type {
  ComponentInternalInstance,
  VueVNode,
} from '../../src/vue/types.js';
import { VUE_APP_KEY } from '../../src/vue/types.js';
import { serializeVueTree } from '../../src/vue/serialize_tree.js';
import { serializeVueComponent } from '../../src/vue/serialize_component.js';

// Synthetic instance-tree builder mirroring vue_module.test.ts: each instance
// carries a placeholder vnode (its key); a parent's subTree is a host <div>
// whose children are the child placeholder vnodes, so collectChildInstances
// discovers them exactly as it would live.
let uidSeq = 0;

type Mut = {
  uid: number;
  type: unknown;
  parent: ComponentInternalInstance | null;
  subTree: VueVNode | null;
  vnode: VueVNode | null;
  props?: unknown;
  setupState?: unknown;
  data?: unknown;
};

const make = (
  name: string,
  extra: Partial<Pick<Mut, 'props' | 'setupState' | 'data'>> = {},
): Mut => {
  const type = { name };
  const vnode = {
    type,
    key: null as string | number | symbol | null,
    component: null as ComponentInternalInstance | null,
    children: null,
  };
  const instance: Mut = {
    uid: uidSeq++,
    type,
    parent: null,
    subTree: null,
    vnode,
    ...extra,
  };
  vnode.component = instance as unknown as ComponentInternalInstance;
  return instance;
};

const hostVNode = (tag: string, children: VueVNode[]): VueVNode =>
  ({ type: tag, key: null, component: null, children }) as VueVNode;

const withChildren = (parent: Mut, children: Mut[]): Mut => {
  for (const c of children)
    c.parent = parent as unknown as ComponentInternalInstance;
  parent.subTree = hostVNode(
    'div',
    children.map((c) => c.vnode as VueVNode),
  );
  return parent;
};

const asI = (m: Mut): ComponentInternalInstance =>
  m as unknown as ComponentInternalInstance;

const mountRoot = (app: Mut): HTMLElement => {
  const el = document.createElement('div');
  (el as unknown as Record<string, unknown>)[VUE_APP_KEY] = {
    _instance: asI(app),
  };
  document.body.appendChild(el);
  return el;
};

describe('serializeVueTree', () => {
  it('serializes a nested tree with stable ids, names, and child structure', () => {
    const deep = make('DeepChild');
    const nested = withChildren(make('NestedSection'), [deep]);
    const counter = make('Counter', { setupState: { count: 0 } });
    const app = withChildren(make('App'), [counter, nested]);
    const el = mountRoot(app);
    try {
      const result = serializeVueTree(document);
      expect(result.rootCount).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.roots).toHaveLength(1);
      const root = result.roots[0]!;
      expect(root.displayName).toBe('App');
      expect(root.children.map((c) => c.displayName)).toEqual([
        'Counter',
        'NestedSection',
      ]);
      const counterNode = root.children[0]!;
      expect(counterNode.hasState).toBe(true);
      expect(counterNode.children).toEqual([]);
      expect(root.children[1]!.children[0]!.displayName).toBe('DeepChild');
    } finally {
      el.remove();
    }
  });

  it('caps depth and flags truncation', () => {
    const deep = make('DeepChild');
    const nested = withChildren(make('NestedSection'), [deep]);
    const app = withChildren(make('App'), [nested]);
    const el = mountRoot(app);
    try {
      const result = serializeVueTree(document, { depthLimit: 1 });
      // depth 0 = App, depth 1 = NestedSection (its children pruned).
      expect(result.truncated).toBe(true);
      const root = result.roots[0]!;
      expect(root.children[0]!.displayName).toBe('NestedSection');
      expect(root.children[0]!.children).toEqual([]);
    } finally {
      el.remove();
    }
  });

  it('caps total node count via maxNodes', () => {
    const app = withChildren(make('App'), [
      make('A'),
      make('B'),
      make('C'),
    ]);
    const el = mountRoot(app);
    try {
      const result = serializeVueTree(document, { maxNodes: 2 });
      expect(result.truncated).toBe(true);
      // App + one child emitted, then the cap stops the walk.
      const root = result.roots[0]!;
      expect(root.children).toHaveLength(1);
    } finally {
      el.remove();
    }
  });

  it('honours rootIndex selection and reports out-of-range as empty', () => {
    const app = make('App');
    const el = mountRoot(app);
    try {
      expect(serializeVueTree(document, { rootIndex: 0 }).roots).toHaveLength(1);
      const oob = serializeVueTree(document, { rootIndex: 9 });
      expect(oob.roots).toEqual([]);
      expect(oob.rootCount).toBe(1);
    } finally {
      el.remove();
    }
  });
});

describe('serializeVueComponent', () => {
  it('includes props, setupState, and data; omits empty surfaces', () => {
    const c = make('Counter', {
      props: { label: 'hi' },
      setupState: { count: 3 },
      data: {},
    });
    const info = serializeVueComponent(asI(c));
    expect(info.displayName).toBe('Counter');
    expect(info.props).toEqual({ label: 'hi' });
    expect(info.setupState).toEqual({ count: 3 });
    expect(info.data).toBeUndefined(); // empty object omitted
    expect(info.truncated).toBeUndefined();
  });

  it('gates props via includeProps and state via includeState', () => {
    const c = make('Counter', {
      props: { label: 'hi' },
      setupState: { count: 3 },
    });
    const noProps = serializeVueComponent(asI(c), 0, { includeProps: false });
    expect(noProps.props).toBeUndefined();
    expect(noProps.setupState).toEqual({ count: 3 });
    const noState = serializeVueComponent(asI(c), 0, { includeState: false });
    expect(noState.setupState).toBeUndefined();
    expect(noState.props).toEqual({ label: 'hi' });
  });

  it('produces a stable id consistent with the tree walk', () => {
    const child = make('Counter');
    const app = withChildren(make('App'), [child]);
    const el = mountRoot(app);
    try {
      const tree = serializeVueTree(document);
      const treeChildId = tree.roots[0]!.children[0]!.stableId;
      expect(serializeVueComponent(asI(child)).stableId).toBe(treeChildId);
    } finally {
      el.remove();
    }
  });
});
