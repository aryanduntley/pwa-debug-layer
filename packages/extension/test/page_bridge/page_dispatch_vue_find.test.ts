import { describe, it, expect } from 'vitest';
import type {
  ComponentInternalInstance,
  VueVNode,
} from '../../src/vue/types.js';
import { VUE_APP_KEY, VUE_PARENT_COMPONENT_KEY } from '../../src/vue/types.js';
import {
  vueFindByTextHandler,
  vueFindByRoleHandler,
} from '../../src/page_bridge/page_dispatch.js';
import type { PageBridgeRequestEnvelope } from '../../src/page_bridge/protocol.js';

let uidSeq = 0;

type Mut = {
  uid: number;
  type: unknown;
  parent: ComponentInternalInstance | null;
  subTree: VueVNode | null;
  vnode: VueVNode | null;
};

const make = (name: string): Mut => {
  const type = { name };
  const vnode = {
    type,
    key: null as string | number | symbol | null,
    component: null as ComponentInternalInstance | null,
    children: null,
  };
  const instance: Mut = { uid: uidSeq++, type, parent: null, subTree: null, vnode };
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

const env = (payload: unknown): PageBridgeRequestEnvelope =>
  ({ requestId: 'r', tool: 't', payload }) as PageBridgeRequestEnvelope;

// Mount App>Counter with Counter owning a <button>Go</button>.
const mount = (): HTMLElement => {
  const counter = make('Counter');
  const app = withChildren(make('App'), [counter]);
  const root = document.createElement('div');
  (root as unknown as Record<string, unknown>)[VUE_APP_KEY] = { _instance: asI(app) };
  (root as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(app);
  const btn = document.createElement('button');
  (btn as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(counter);
  btn.textContent = 'Go';
  root.appendChild(btn);
  document.body.appendChild(root);
  return root;
};

describe('vueFindByTextHandler', () => {
  it('finds a component by text', () => {
    const root = mount();
    try {
      const res = vueFindByTextHandler(env({ pattern: 'Go' }));
      if ('error' in res) throw new Error('unexpected error');
      expect(res.matches.some((m) => m.displayName === 'Counter')).toBe(true);
    } finally {
      root.remove();
    }
  });

  it('rejects a missing pattern and an invalid regex', () => {
    expect('error' in vueFindByTextHandler(env({}))).toBe(true);
    const bad = vueFindByTextHandler(env({ pattern: '(' }));
    expect('error' in bad).toBe(true);
    if ('error' in bad) expect(bad.error.message).toContain('invalid regex');
  });
});

describe('vueFindByRoleHandler', () => {
  it('finds a component by role + name', () => {
    const root = mount();
    try {
      const res = vueFindByRoleHandler(env({ role: 'button', name: 'Go' }));
      if ('error' in res) throw new Error('unexpected error');
      const m = res.matches.find((x) => x.displayName === 'Counter');
      expect(m?.role).toBe('button');
      expect(m?.name).toBe('Go');
    } finally {
      root.remove();
    }
  });

  it('rejects a missing role and an invalid name regex', () => {
    expect('error' in vueFindByRoleHandler(env({}))).toBe(true);
    const bad = vueFindByRoleHandler(env({ role: 'button', name: '(' }));
    expect('error' in bad).toBe(true);
    if ('error' in bad) expect(bad.error.message).toContain('invalid name regex');
  });
});
