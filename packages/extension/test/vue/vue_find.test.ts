import { describe, it, expect } from 'vitest';
import type {
  ComponentInternalInstance,
  VueVNode,
} from '../../src/vue/types.js';
import { VUE_APP_KEY, VUE_PARENT_COMPONENT_KEY } from '../../src/vue/types.js';
import { findVueByText } from '../../src/vue/find_by_text.js';
import { findVueByRole } from '../../src/vue/find_by_role.js';

// Synthetic instance + DOM builder. Each component instance owns a real jsdom
// element (tagged with __vueParentComponent) so getInstanceForNode maps the DOM
// node back to it, and a placeholder vnode so computeStableId/collectChildInstances
// can derive its identity exactly as in the live runtime.
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

/** Render a component's owned DOM element (tagged to that instance). */
const ownedEl = (
  parent: Element,
  instance: Mut,
  tag: string,
  build: (el: HTMLElement) => void,
): HTMLElement => {
  const el = document.createElement(tag);
  (el as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(instance);
  build(el);
  parent.appendChild(el);
  return el;
};

describe('findVueByText', () => {
  it('matches components by rendered text and dedupes per component', () => {
    const counter = make('Counter');
    const app = withChildren(make('App'), [counter]);
    const root = document.createElement('div');
    (root as unknown as Record<string, unknown>)[VUE_APP_KEY] = { _instance: asI(app) };
    (root as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(app);
    // Counter owns two spans both containing "Count" — should yield ONE match.
    ownedEl(root, counter, 'span', (e) => (e.textContent = 'Count: 3'));
    ownedEl(root, counter, 'span', (e) => (e.textContent = 'Counter value'));
    document.body.appendChild(root);
    try {
      const res = findVueByText(document, /Count/);
      expect(res.rootCount).toBe(1);
      const counterMatches = res.matches.filter((m) => m.displayName === 'Counter');
      expect(counterMatches).toHaveLength(1);
      expect(counterMatches[0]!.matchedText).toBe('Count');
    } finally {
      root.remove();
    }
  });

  it('exact:true requires the full trimmed text to match', () => {
    const counter = make('Counter');
    const app = withChildren(make('App'), [counter]);
    const root = document.createElement('div');
    (root as unknown as Record<string, unknown>)[VUE_APP_KEY] = { _instance: asI(app) };
    (root as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(app);
    ownedEl(root, counter, 'span', (e) => (e.textContent = 'Hello World'));
    document.body.appendChild(root);
    try {
      expect(findVueByText(document, /Hello/, { exact: true }).matches).toHaveLength(0);
      const exactRes = findVueByText(document, /Hello World/, { exact: true });
      expect(exactRes.matches.some((m) => m.displayName === 'Counter')).toBe(true);
    } finally {
      root.remove();
    }
  });

  it('caps matches at maxMatches and flags truncation', () => {
    const a = make('A');
    const b = make('B');
    const app = withChildren(make('App'), [a, b]);
    const root = document.createElement('div');
    (root as unknown as Record<string, unknown>)[VUE_APP_KEY] = { _instance: asI(app) };
    (root as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(app);
    ownedEl(root, a, 'span', (e) => (e.textContent = 'match-a'));
    ownedEl(root, b, 'span', (e) => (e.textContent = 'match-b'));
    document.body.appendChild(root);
    try {
      const res = findVueByText(document, /match/, { maxMatches: 1 });
      expect(res.matches).toHaveLength(1);
      expect(res.truncated).toBe(true);
    } finally {
      root.remove();
    }
  });
});

describe('findVueByRole', () => {
  it('matches by implicit role and optional accessible name', () => {
    const counter = make('Counter');
    const app = withChildren(make('App'), [counter]);
    const root = document.createElement('div');
    (root as unknown as Record<string, unknown>)[VUE_APP_KEY] = { _instance: asI(app) };
    (root as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(app);
    ownedEl(root, counter, 'button', (e) => (e.textContent = 'Increment'));
    document.body.appendChild(root);
    try {
      const all = findVueByRole(document, 'button', undefined);
      const m = all.matches.find((x) => x.displayName === 'Counter');
      expect(m).toBeDefined();
      expect(m!.role).toBe('button');
      expect(m!.name).toBe('Increment');
      // Name filter that excludes it:
      expect(
        findVueByRole(document, 'button', /Decrement/).matches.some(
          (x) => x.displayName === 'Counter',
        ),
      ).toBe(false);
    } finally {
      root.remove();
    }
  });

  it('honors an explicit role attribute', () => {
    const profile = make('UserProfile');
    const app = withChildren(make('App'), [profile]);
    const root = document.createElement('div');
    (root as unknown as Record<string, unknown>)[VUE_APP_KEY] = { _instance: asI(app) };
    (root as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] = asI(app);
    ownedEl(root, profile, 'div', (e) => {
      e.setAttribute('role', 'region');
      e.setAttribute('aria-label', 'Profile');
    });
    document.body.appendChild(root);
    try {
      const res = findVueByRole(document, 'region', /Profile/);
      const m = res.matches.find((x) => x.displayName === 'UserProfile');
      expect(m).toBeDefined();
      expect(m!.name).toBe('Profile');
    } finally {
      root.remove();
    }
  });
});
