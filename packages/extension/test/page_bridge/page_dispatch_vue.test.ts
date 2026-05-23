import { describe, it, expect } from 'vitest';
import type {
  ComponentInternalInstance,
  VueVNode,
} from '../../src/vue/types.js';
import { VUE_APP_KEY, VUE_PARENT_COMPONENT_KEY } from '../../src/vue/types.js';
import {
  vueTreeHandler,
  vueGetStateHandler,
  readVueTreeInput,
  readVueGetStateInput,
} from '../../src/page_bridge/page_dispatch.js';
import type { PageBridgeRequestEnvelope } from '../../src/page_bridge/protocol.js';

let uidSeq = 0;

type Mut = {
  uid: number;
  type: unknown;
  parent: ComponentInternalInstance | null;
  subTree: VueVNode | null;
  vnode: VueVNode | null;
  props?: unknown;
  setupState?: unknown;
};

const make = (name: string, extra: Partial<Mut> = {}): Mut => {
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

// Mount a synthetic app and tag a DOM node with __vueParentComponent so
// resolveStableId's element-anchored root walk has a node to start from.
const mountApp = (app: Mut): HTMLElement => {
  const el = document.createElement('div');
  (el as unknown as Record<string, unknown>)[VUE_APP_KEY] = { _instance: asI(app) };
  (el as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(app);
  document.body.appendChild(el);
  return el;
};

const env = (payload: unknown): PageBridgeRequestEnvelope =>
  ({ requestId: 'r', tool: 't', payload }) as PageBridgeRequestEnvelope;

describe('readVueTreeInput / readVueGetStateInput', () => {
  it('parses tree options and ignores invalid values', () => {
    expect(readVueTreeInput({ root_index: 1, depth_limit: 3, max_nodes: 50 })).toEqual({
      rootIndex: 1,
      depthLimit: 3,
      maxNodes: 50,
    });
    expect(readVueTreeInput({ depth_limit: 0, root_index: -1 })).toEqual({});
    expect(readVueTreeInput(null)).toEqual({});
  });

  it('requires a non-empty stable_id for get_state', () => {
    expect(readVueGetStateInput({ stable_id: '' })).toBeNull();
    expect(readVueGetStateInput({})).toBeNull();
    expect(
      readVueGetStateInput({ stable_id: 'x', include_props: false }),
    ).toEqual({ stableId: 'x', options: { includeProps: false } });
  });
});

describe('vueTreeHandler', () => {
  it('serializes the mounted Vue tree', () => {
    const counter = make('Counter', { setupState: { count: 1 } });
    const app = withChildren(make('App'), [counter]);
    const el = mountApp(app);
    try {
      const result = vueTreeHandler(env({}));
      expect(result.rootCount).toBe(1);
      expect(result.roots[0]!.displayName).toBe('App');
      expect(result.roots[0]!.children[0]!.displayName).toBe('Counter');
    } finally {
      el.remove();
    }
  });
});

describe('vueGetStateHandler', () => {
  it('resolves a stable id from vue_tree and returns its state', () => {
    const counter = make('Counter', {
      props: { label: 'hi' },
      setupState: { count: 2 },
    });
    const app = withChildren(make('App'), [counter]);
    const el = mountApp(app);
    try {
      const tree = vueTreeHandler(env({}));
      const childId = tree.roots[0]!.children[0]!.stableId;
      const info = vueGetStateHandler(env({ stable_id: childId }));
      expect('error' in info).toBe(false);
      if ('error' in info) throw new Error('unexpected error payload');
      expect(info.displayName).toBe('Counter');
      expect(info.props).toEqual({ label: 'hi' });
      expect(info.setupState).toEqual({ count: 2 });
    } finally {
      el.remove();
    }
  });

  it('returns a tool error for a bad payload', () => {
    const info = vueGetStateHandler(env({ stable_id: '' }));
    expect('error' in info).toBe(true);
  });

  it('returns a tool error when the stable id does not resolve', () => {
    const app = make('App');
    const el = mountApp(app);
    try {
      const info = vueGetStateHandler(env({ stable_id: 'root0/Nope' }));
      expect('error' in info).toBe(true);
      if ('error' in info) {
        expect(info.error.message).toContain('did not resolve');
      }
    } finally {
      el.remove();
    }
  });
});
