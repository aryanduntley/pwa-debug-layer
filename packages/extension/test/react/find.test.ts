import { describe, it, expect } from 'vitest';
import {
  walkAndFilter,
  implicitRoleForElement,
  computeAccessibleName,
} from '../../src/react/find.js';
import type { Fiber } from '../../src/react/types.js';

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

const hostFiber = (el: Element): Fiber => f({ tag: HOST_COMPONENT_TAG, stateNode: el });

describe('walkAndFilter', () => {
  it('collects HostComponent fibers whose host node passes the predicate', () => {
    const root = f({ tag: FUNCTION_COMPONENT_TAG });
    const btn = hostFiber(document.createElement('button'));
    const div = hostFiber(document.createElement('div'));
    link(root, [btn, div]);

    const result = walkAndFilter([root], (_fiber, el) => el.tagName === 'BUTTON');
    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.fiber).toBe(btn);
    expect(result.matches[0]!.hostNode.tagName).toBe('BUTTON');
  });

  it('descends through non-host composite fibers to reach host nodes', () => {
    const root = f({ tag: FUNCTION_COMPONENT_TAG });
    const composite = f({ tag: FUNCTION_COMPONENT_TAG });
    const span = hostFiber(document.createElement('span'));
    link(root, [composite]);
    link(composite, [span]);

    const result = walkAndFilter([root], () => true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.hostNode.tagName).toBe('SPAN');
  });

  it('skips HostComponent fibers whose stateNode is not an Element', () => {
    const root = f({ tag: FUNCTION_COMPONENT_TAG });
    const textish = f({ tag: HOST_COMPONENT_TAG, stateNode: { nodeType: 3 } });
    const nullNode = f({ tag: HOST_COMPONENT_TAG, stateNode: null });
    link(root, [textish, nullNode]);

    const result = walkAndFilter([root], () => true);
    expect(result.matches).toEqual([]);
  });

  it('caps at maxMatches and marks truncated', () => {
    const root = f({ tag: FUNCTION_COMPONENT_TAG });
    const kids = ['a', 'b', 'c', 'd'].map(() => hostFiber(document.createElement('p')));
    link(root, kids);

    const result = walkAndFilter([root], () => true, { maxMatches: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('does not mark truncated when matches land exactly on the cap', () => {
    const root = f({ tag: FUNCTION_COMPONENT_TAG });
    const kids = ['a', 'b'].map(() => hostFiber(document.createElement('p')));
    link(root, kids);

    const result = walkAndFilter([root], () => true, { maxMatches: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('is uncapped when maxMatches is omitted', () => {
    const root = f({ tag: FUNCTION_COMPONENT_TAG });
    const kids = Array.from({ length: 50 }, () => hostFiber(document.createElement('i')));
    link(root, kids);

    const result = walkAndFilter([root], () => true);
    expect(result.matches).toHaveLength(50);
    expect(result.truncated).toBe(false);
  });

  it('walks every root independently', () => {
    const r1 = f({ tag: FUNCTION_COMPONENT_TAG });
    const r2 = f({ tag: FUNCTION_COMPONENT_TAG });
    link(r1, [hostFiber(document.createElement('button'))]);
    link(r2, [hostFiber(document.createElement('button'))]);

    const result = walkAndFilter([r1, r2], (_fiber, el) => el.tagName === 'BUTTON');
    expect(result.matches).toHaveLength(2);
  });

  it('returns no matches for an empty roots array', () => {
    expect(walkAndFilter([], () => true)).toEqual({ matches: [], truncated: false });
  });
});

describe('implicitRoleForElement', () => {
  const el = (tag: string, attrs: Record<string, string> = {}): Element => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  it('an explicit role attribute always wins', () => {
    expect(implicitRoleForElement(el('button', { role: 'tab' }))).toBe('tab');
    expect(implicitRoleForElement(el('div', { role: 'dialog' }))).toBe('dialog');
  });

  it('uses the first token of a multi-valued role attribute', () => {
    expect(implicitRoleForElement(el('div', { role: '  menuitem  option ' }))).toBe('menuitem');
  });

  it('maps common interactive/landmark/heading tags', () => {
    expect(implicitRoleForElement(el('button'))).toBe('button');
    expect(implicitRoleForElement(el('nav'))).toBe('navigation');
    expect(implicitRoleForElement(el('main'))).toBe('main');
    expect(implicitRoleForElement(el('header'))).toBe('banner');
    expect(implicitRoleForElement(el('footer'))).toBe('contentinfo');
    expect(implicitRoleForElement(el('aside'))).toBe('complementary');
    expect(implicitRoleForElement(el('section'))).toBe('region');
    expect(implicitRoleForElement(el('img'))).toBe('img');
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(implicitRoleForElement(el(h))).toBe('heading');
    }
  });

  it('anchor is a link only when it has href', () => {
    expect(implicitRoleForElement(el('a'))).toBeUndefined();
    expect(implicitRoleForElement(el('a', { href: '/x' }))).toBe('link');
  });

  it('derives input role from the type attribute', () => {
    expect(implicitRoleForElement(el('input'))).toBe('textbox');
    expect(implicitRoleForElement(el('input', { type: 'checkbox' }))).toBe('checkbox');
    expect(implicitRoleForElement(el('input', { type: 'radio' }))).toBe('radio');
    expect(implicitRoleForElement(el('input', { type: 'submit' }))).toBe('button');
    expect(implicitRoleForElement(el('input', { type: 'search' }))).toBe('searchbox');
    expect(implicitRoleForElement(el('input', { type: 'range' }))).toBe('slider');
  });

  it('select is listbox when multiple, combobox otherwise', () => {
    expect(implicitRoleForElement(el('select'))).toBe('combobox');
    expect(implicitRoleForElement(el('select', { multiple: '' }))).toBe('listbox');
  });

  it('returns undefined for unmapped tags', () => {
    expect(implicitRoleForElement(el('div'))).toBeUndefined();
    expect(implicitRoleForElement(el('span'))).toBeUndefined();
  });
});

describe('computeAccessibleName', () => {
  it('prefers a non-empty aria-label', () => {
    const node = document.createElement('button');
    node.setAttribute('aria-label', '  Save changes  ');
    node.textContent = 'ignored';
    expect(computeAccessibleName(node)).toBe('Save changes');
  });

  it('falls through an empty aria-label to textContent', () => {
    const node = document.createElement('button');
    node.setAttribute('aria-label', '   ');
    node.textContent = 'Click me';
    expect(computeAccessibleName(node)).toBe('Click me');
  });

  it('resolves the first aria-labelledby id reference', () => {
    document.body.innerHTML = '';
    const label = document.createElement('span');
    label.id = 'lbl1';
    label.textContent = 'Profile';
    const node = document.createElement('button');
    node.setAttribute('aria-labelledby', 'lbl1 lbl2');
    document.body.append(label, node);

    expect(computeAccessibleName(node)).toBe('Profile');
    document.body.innerHTML = '';
  });

  it('falls back to trimmed textContent', () => {
    const node = document.createElement('div');
    node.textContent = '  Hello world  ';
    expect(computeAccessibleName(node)).toBe('Hello world');
  });

  it('returns undefined when there is no name', () => {
    expect(computeAccessibleName(document.createElement('div'))).toBeUndefined();
  });
});
