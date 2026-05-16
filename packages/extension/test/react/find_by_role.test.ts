import { describe, it, expect } from 'vitest';
import { findByRole } from '../../src/react/find_by_role.js';
import { computeStableId } from '../../src/react/compute_stable_id.js';
import { REACT_CONTAINER_KEY_PREFIX } from '../../src/react/types.js';
import type { Fiber } from '../../src/react/types.js';

const HOST_ROOT_TAG = 3;
const FUNCTION_COMPONENT_TAG = 0;
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

const el = (
  tag: string,
  attrs: Record<string, string> = {},
  text?: string,
): Element => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};

const host = (e: Element, key: string | null = null): Fiber =>
  f({ tag: HOST_COMPONENT_TAG, type: e.tagName.toLowerCase(), key, stateNode: e });

const containerEl = (root: Fiber): Element => {
  const c = {} as Record<string, unknown>;
  c[`${REACT_CONTAINER_KEY_PREFIX}abc`] = { current: root };
  return c as unknown as Element;
};

const docOf = (containers: Element[]): Document =>
  ({
    querySelectorAll: (sel: string) => {
      if (sel !== '*') throw new Error(`unexpected selector ${sel}`);
      return containers;
    },
  }) as unknown as Document;

const treeOf = (...hosts: Fiber[]): Fiber => {
  const root = f({ tag: HOST_ROOT_TAG });
  const app = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'App' } });
  link(root, [app]);
  link(app, hosts);
  return root;
};

describe('findByRole', () => {
  it('returns rootCount=0 and no matches when no React roots exist', () => {
    expect(findByRole(docOf([]), 'button', undefined)).toEqual({
      matches: [],
      truncated: false,
      rootCount: 0,
    });
  });

  it('matches by implicit role derived from the tag', () => {
    const btn = host(el('button', {}, 'Save'));
    const div = host(el('div', {}, 'nope'));
    const root = treeOf(btn, div);
    const r = findByRole(docOf([containerEl(root)]), 'button', undefined);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.role).toBe('button');
    expect(r.matches[0]!.displayName).toBe('button');
    expect(r.matches[0]!.name).toBe('Save');
    expect(r.matches[0]!.stableId).toBe(computeStableId(btn, 0));
  });

  it('matches an explicit role attribute over the implicit tag role', () => {
    const dlg = host(el('div', { role: 'dialog' }, 'Settings'));
    const root = treeOf(dlg);
    expect(
      findByRole(docOf([containerEl(root)]), 'dialog', undefined).matches,
    ).toHaveLength(1);
    expect(
      findByRole(docOf([containerEl(root)]), 'button', undefined).matches,
    ).toEqual([]);
  });

  it('narrows matches by an accessible-name regex', () => {
    const save = host(el('button', { 'aria-label': 'Save changes' }));
    const cancel = host(el('button', {}, 'Cancel'));
    const root = treeOf(save, cancel);
    const doc = docOf([containerEl(root)]);

    const all = findByRole(doc, 'button', undefined);
    expect(all.matches).toHaveLength(2);

    const saveOnly = findByRole(doc, 'button', /Save/);
    expect(saveOnly.matches).toHaveLength(1);
    expect(saveOnly.matches[0]!.name).toBe('Save changes');
  });

  it('returns no matches when the role differs', () => {
    const root = treeOf(host(el('span', {}, 'x')));
    expect(
      findByRole(docOf([containerEl(root)]), 'button', undefined).matches,
    ).toEqual([]);
  });

  it('searches all roots by default and scopes with rootIndex', () => {
    const r0 = treeOf(host(el('button', {}, 'one')));
    const r1 = treeOf(host(el('button', {}, 'two')));
    const doc = docOf([containerEl(r0), containerEl(r1)]);

    const all = findByRole(doc, 'button', undefined);
    expect(all.rootCount).toBe(2);
    expect(all.matches).toHaveLength(2);

    const scoped = findByRole(doc, 'button', undefined, { rootIndex: 1 });
    expect(scoped.matches).toHaveLength(1);
    expect(scoped.matches[0]!.stableId.startsWith('root1')).toBe(true);
  });

  it('rootIndex out of range yields no matches but preserves rootCount', () => {
    const root = treeOf(host(el('button', {}, 'x')));
    const r = findByRole(docOf([containerEl(root)]), 'button', undefined, {
      rootIndex: 9,
    });
    expect(r.rootCount).toBe(1);
    expect(r.matches).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('caps at maxMatches and marks truncated', () => {
    const root = treeOf(
      host(el('button', {}, 'a')),
      host(el('button', {}, 'b')),
      host(el('button', {}, 'c')),
    );
    const r = findByRole(docOf([containerEl(root)]), 'button', undefined, {
      maxMatches: 2,
    });
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('includes key only when set and omits name when there is no accessible name', () => {
    const keyed = host(el('img', { 'aria-label': 'avatar' }), 'img-1');
    const nameless = host(el('img'));
    const root = treeOf(keyed, nameless);
    const r = findByRole(docOf([containerEl(root)]), 'img', undefined);
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0]!.key).toBe('img-1');
    expect(r.matches[0]!.name).toBe('avatar');
    expect('key' in r.matches[1]!).toBe(false);
    expect('name' in r.matches[1]!).toBe(false);
  });
});
