import { describe, it, expect } from 'vitest';
import { findByText } from '../../src/react/find_by_text.js';
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

const hostEl = (tag: string, text: string): Element => {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
};

const host = (tag: string, text: string, key: string | null = null): Fiber =>
  f({ tag: HOST_COMPONENT_TAG, type: tag, key, stateNode: hostEl(tag, text) });

const containerEl = (root: Fiber): Element => {
  const el = {} as Record<string, unknown>;
  el[`${REACT_CONTAINER_KEY_PREFIX}abc`] = { current: root };
  return el as unknown as Element;
};

const docOf = (containers: Element[]): Document =>
  ({
    querySelectorAll: (sel: string) => {
      if (sel !== '*') throw new Error(`unexpected selector ${sel}`);
      return containers;
    },
  }) as unknown as Document;

describe('findByText', () => {
  it('returns rootCount=0 and no matches when no React roots exist', () => {
    expect(findByText(docOf([]), /anything/)).toEqual({
      matches: [],
      truncated: false,
      rootCount: 0,
    });
  });

  it('collects HostComponent fibers whose text matches (substring/partial default)', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'App' } });
    const btn = host('button', 'Save todo-marker-A');
    const div = host('div', 'unrelated copy');
    link(root, [app]);
    link(app, [btn, div]);

    const result = findByText(docOf([containerEl(root)]), /todo-marker-A/);
    expect(result.rootCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(1);
    const m = result.matches[0]!;
    expect(m.displayName).toBe('button');
    expect(m.matchedText).toBe('todo-marker-A');
    expect(m.stableId).toBe(computeStableId(btn, 0));
    expect(m.stableId.startsWith('root0/App[0]/button')).toBe(true);
  });

  it('exact:true requires the full trimmed text to match', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'App' } });
    const exactBtn = host('button', 'Exact');
    const partialBtn = host('button', 'Save Exact thing');
    link(root, [app]);
    link(app, [exactBtn, partialBtn]);

    const exactRes = findByText(docOf([containerEl(root)]), /Exact/, {
      exact: true,
    });
    expect(exactRes.matches).toHaveLength(1);
    expect(exactRes.matches[0]!.matchedText).toBe('Exact');

    // substring of the text but not the whole text → no exact match
    const noRes = findByText(docOf([containerEl(root)]), /xact/, {
      exact: true,
    });
    expect(noRes.matches).toEqual([]);
  });

  it('returns no matches when nothing matches and skips empty text', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'App' } });
    const empty = host('div', '   ');
    const filled = host('span', 'hello');
    link(root, [app]);
    link(app, [empty, filled]);

    expect(findByText(docOf([containerEl(root)]), /nope/).matches).toEqual([]);
    expect(findByText(docOf([containerEl(root)]), /.*/).matches).toHaveLength(1);
  });

  it('searches all roots by default and scopes to one with rootIndex', () => {
    const r0 = f({ tag: HOST_ROOT_TAG });
    const a0 = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'A0' } });
    link(r0, [a0]);
    link(a0, [host('button', 'hit one')]);
    const r1 = f({ tag: HOST_ROOT_TAG });
    const a1 = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'A1' } });
    link(r1, [a1]);
    link(a1, [host('button', 'hit two')]);
    const doc = docOf([containerEl(r0), containerEl(r1)]);

    const all = findByText(doc, /hit/);
    expect(all.rootCount).toBe(2);
    expect(all.matches).toHaveLength(2);

    const scoped = findByText(doc, /hit/, { rootIndex: 1 });
    expect(scoped.rootCount).toBe(2);
    expect(scoped.matches).toHaveLength(1);
    expect(scoped.matches[0]!.stableId.startsWith('root1')).toBe(true);
  });

  it('rootIndex out of range yields no matches but preserves rootCount', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'App' } });
    link(root, [app]);
    link(app, [host('button', 'x')]);
    const r = findByText(docOf([containerEl(root)]), /x/, { rootIndex: 9 });
    expect(r.rootCount).toBe(1);
    expect(r.matches).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('caps at maxMatches and marks truncated', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'App' } });
    link(root, [app]);
    link(app, [
      host('button', 'go 1'),
      host('button', 'go 2'),
      host('button', 'go 3'),
    ]);
    const r = findByText(docOf([containerEl(root)]), /go/, { maxMatches: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('includes key only when the fiber has a non-empty key', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = f({ tag: FUNCTION_COMPONENT_TAG, type: { displayName: 'App' } });
    const keyed = host('li', 'row alpha', 'row-7');
    const unkeyed = host('li', 'row beta');
    link(root, [app]);
    link(app, [keyed, unkeyed]);

    const r = findByText(docOf([containerEl(root)]), /row/);
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0]!.key).toBe('row-7');
    expect('key' in r.matches[1]!).toBe(false);
  });
});
