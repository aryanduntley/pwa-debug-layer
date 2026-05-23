import { describe, it, expect } from 'vitest';
import type {
  ComponentInternalInstance,
  VueVNode,
} from '../../src/vue/types.js';
import { VUE_APP_KEY, VUE_PARENT_COMPONENT_KEY } from '../../src/vue/types.js';
import { findVueRoots } from '../../src/vue/find_vue_roots.js';
import { getRootInstance } from '../../src/vue/get_root_instance.js';
import { getInstanceForNode } from '../../src/vue/get_instance_for_node.js';
import { collectChildInstances } from '../../src/vue/collect_child_instances.js';
import { extractDisplayName } from '../../src/vue/extract_display_name.js';
import { extractKey } from '../../src/vue/extract_key.js';
import { unkeyedOccurrence } from '../../src/vue/unkeyed_occurrence.js';
import { computeStableId } from '../../src/vue/compute_stable_id.js';
import { walkInstanceTree } from '../../src/vue/walk_instance_tree.js';
import { resolveStableId } from '../../src/vue/resolve_stable_id.js';

// ---- synthetic instance-tree builder (the Vue analogue of the react tests'
// synthetic fibers): each instance gets a placeholder vnode carrying its key;
// a parent's subTree is a host <div> whose children are the child placeholder
// vnodes, so collectChildInstances discovers them exactly as it would live.

let uidSeq = 0;

type Mut = {
  uid: number;
  type: unknown;
  parent: ComponentInternalInstance | null;
  subTree: VueVNode | null;
  vnode: VueVNode | null;
};

type MakeOpts = {
  key?: string | number | symbol | null;
  file?: string;
  type?: unknown;
};

const make = (name: string, opts: MakeOpts = {}): Mut => {
  const type =
    opts.type ?? (opts.file !== undefined ? { __file: opts.file } : { name });
  const vnode = {
    type,
    key: opts.key ?? null,
    component: null as ComponentInternalInstance | null,
    children: null,
  };
  const instance: Mut = { uid: uidSeq++, type, parent: null, subTree: null, vnode };
  vnode.component = instance as unknown as ComponentInternalInstance;
  return instance;
};

const hostVNode = (tag: string, children: VueVNode[]): VueVNode =>
  ({ type: tag, key: null, component: null, children }) as VueVNode;

/** Attach children directly under the parent's subTree host root. */
const withChildren = (parent: Mut, children: Mut[]): Mut => {
  for (const c of children) c.parent = parent as unknown as ComponentInternalInstance;
  parent.subTree = hostVNode(
    'div',
    children.map((c) => c.vnode as VueVNode),
  );
  return parent;
};

const asI = (m: Mut): ComponentInternalInstance =>
  m as unknown as ComponentInternalInstance;

describe('findVueRoots / getRootInstance / getInstanceForNode', () => {
  it('finds mount containers and resolves the root instance', () => {
    const app = make('App');
    const el = document.createElement('div');
    (el as unknown as Record<string, unknown>)[VUE_APP_KEY] = {
      _instance: asI(app),
    };
    document.body.appendChild(el);
    try {
      const roots = findVueRoots(document);
      expect(roots).toContain(el);
      expect(getRootInstance(el)).toBe(asI(app));
    } finally {
      el.remove();
    }
  });

  it('returns undefined root instance when __vue_app__ is absent/malformed', () => {
    const bare = document.createElement('div');
    expect(getRootInstance(bare)).toBeUndefined();
  });

  it('maps a DOM node to its rendering instance via __vueParentComponent', () => {
    const counter = make('Counter');
    const el = document.createElement('span');
    (el as unknown as Record<string, unknown>)[VUE_PARENT_COMPONENT_KEY] =
      asI(counter);
    expect(getInstanceForNode(el)).toBe(asI(counter));
    expect(getInstanceForNode(document.createElement('p'))).toBeUndefined();
  });
});

describe('collectChildInstances', () => {
  it('collects immediate component children and stops at component boundaries', () => {
    const child = make('Counter');
    const grandchild = make('DeepChild');
    withChildren(child, [grandchild]); // child has its own subtree
    const app = make('App');
    withChildren(app, [child]);
    const kids = collectChildInstances(asI(app));
    expect(kids.map((k) => k.uid)).toEqual([child.uid]); // not grandchild
  });

  it('descends host/fragment wrapper vnodes to find nested components', () => {
    const deep = make('DeepChild');
    const app = make('App');
    // subTree: div > section > [DeepChild placeholder]
    app.subTree = hostVNode('div', [
      hostVNode('section', [deep.vnode as VueVNode]),
    ]);
    deep.parent = asI(app);
    expect(collectChildInstances(asI(app)).map((k) => k.uid)).toEqual([deep.uid]);
  });

  it('returns [] for a null subTree', () => {
    expect(collectChildInstances(asI(make('X')))).toEqual([]);
  });
});

describe('extractDisplayName', () => {
  it('prefers name, then __name, then __file basename, else Anonymous', () => {
    expect(extractDisplayName(asI(make('Counter')))).toBe('Counter');
    expect(extractDisplayName(asI(make('x', { type: { __name: 'SetupName' } })))).toBe(
      'SetupName',
    );
    expect(
      extractDisplayName(asI(make('x', { file: '/a/b/UserProfile.vue?vue&type=script' }))),
    ).toBe('UserProfile');
    expect(extractDisplayName(asI(make('x', { type: {} })))).toBe('Anonymous');
  });
});

describe('extractKey', () => {
  it('stringifies string/number keys and treats null/symbol as unkeyed', () => {
    expect(extractKey(asI(make('I', { key: 'a' })))).toBe('a');
    expect(extractKey(asI(make('I', { key: 7 })))).toBe('7');
    expect(extractKey(asI(make('I')))).toBeUndefined();
    expect(extractKey(asI(make('I', { key: Symbol('s') })))).toBeUndefined();
  });
});

describe('unkeyedOccurrence', () => {
  it('counts prior unkeyed same-name siblings, ignoring keyed ones', () => {
    const a = make('Row');
    const b = make('Row');
    const c = make('Row', { key: 'k' });
    const d = make('Row');
    const parent = make('List');
    withChildren(parent, [a, b, c, d]);
    expect(unkeyedOccurrence(asI(a))).toBe(0);
    expect(unkeyedOccurrence(asI(b))).toBe(1);
    expect(unkeyedOccurrence(asI(d))).toBe(2); // c is keyed, not counted
  });

  it('returns 0 for a root instance', () => {
    expect(unkeyedOccurrence(asI(make('App')))).toBe(0);
  });
});

describe('computeStableId', () => {
  it('produces root0/App[0] for the root component', () => {
    expect(computeStableId(asI(make('App')))).toBe('root0/App[0]');
  });

  it('honours rootIndex', () => {
    expect(computeStableId(asI(make('App')), 2)).toBe('root2/App[0]');
  });

  it('produces a path for a nested counter', () => {
    const counter = make('Counter');
    const app = make('App');
    withChildren(app, [counter]);
    expect(computeStableId(asI(counter))).toBe('root0/App[0]/Counter[0]');
  });

  it('uses keys and unkeyed occurrence for sibling discriminators', () => {
    const r0 = make('Row');
    const r1 = make('Row');
    const keyed = make('Row', { key: 'x' });
    const list = make('List');
    withChildren(list, [r0, r1, keyed]);
    expect(computeStableId(asI(r1)).endsWith('/Row[1]')).toBe(true);
    expect(computeStableId(asI(keyed)).endsWith('/Row[x]')).toBe(true);
  });
});

describe('walkInstanceTree', () => {
  it('visits depth-first with depth and supports pruning', () => {
    const deep = make('DeepChild');
    const nested = make('NestedSection');
    withChildren(nested, [deep]);
    const counter = make('Counter');
    const app = make('App');
    withChildren(app, [counter, nested]);

    const seen: Array<[string, number]> = [];
    walkInstanceTree(asI(app), (i, d) => {
      seen.push([extractDisplayName(i), d]);
    });
    expect(seen).toEqual([
      ['App', 0],
      ['Counter', 1],
      ['NestedSection', 1],
      ['DeepChild', 2],
    ]);

    const pruned: string[] = [];
    walkInstanceTree(asI(app), (i) => {
      pruned.push(extractDisplayName(i));
      if (extractDisplayName(i) === 'NestedSection') return false;
    });
    expect(pruned).not.toContain('DeepChild');
  });
});

describe('resolveStableId (inverse of computeStableId)', () => {
  const mountRoot = (app: Mut): Element => {
    const el = document.createElement('div');
    (el as unknown as Record<string, unknown>)[VUE_APP_KEY] = {
      _instance: asI(app),
    };
    return el;
  };

  it('round-trips ids back to instances (root, nested, keyed, unkeyed)', () => {
    const r0 = make('Row');
    const r1 = make('Row');
    const keyed = make('Row', { key: 'x' });
    const list = make('List');
    withChildren(list, [r0, r1, keyed]);
    const counter = make('Counter');
    const app = make('App');
    withChildren(app, [counter, list]);
    const roots = [mountRoot(app)];

    for (const target of [app, counter, list, r0, r1, keyed]) {
      const id = computeStableId(asI(target), 0);
      expect(resolveStableId(id, roots)).toBe(asI(target));
    }
  });

  it('returns undefined for malformed ids and out-of-range roots', () => {
    const app = make('App');
    const roots = [mountRoot(app)];
    expect(resolveStableId('nope', roots)).toBeUndefined();
    expect(resolveStableId('root5/App[0]', roots)).toBeUndefined();
    expect(resolveStableId('root0/Wrong[0]', roots)).toBeUndefined();
    expect(resolveStableId('root0/App[0]/Ghost[0]', roots)).toBeUndefined();
  });
});
