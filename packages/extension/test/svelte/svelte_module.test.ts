import { describe, it, expect, afterEach } from 'vitest';
import { SVELTE_META_KEY, SVELTE_GLOBAL_KEY } from '../../src/svelte/types.js';
import { getSvelteMeta, componentFileForNode } from '../../src/svelte/meta.js';
import { detectSvelte } from '../../src/svelte/detect.js';
import { discoverSvelteComponents } from '../../src/svelte/discover.js';

const tagMeta = (el: Element, file: string, line?: number, column?: number): void => {
  (el as unknown as Record<string, unknown>)[SVELTE_META_KEY] = {
    loc: { file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) },
  };
};

const roots: HTMLElement[] = [];
const mount = (build: (root: HTMLElement) => void): HTMLElement => {
  const root = document.createElement('div');
  build(root);
  document.body.appendChild(root);
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
  delete (globalThis as unknown as Record<string, unknown>)[SVELTE_GLOBAL_KEY];
});

describe('getSvelteMeta', () => {
  it('reads __svelte_meta.loc and returns undefined when absent/malformed', () => {
    const el = document.createElement('div');
    expect(getSvelteMeta(el)).toBeUndefined();
    tagMeta(el, 'src/App.svelte', 3, 4);
    expect(getSvelteMeta(el)).toEqual({ loc: { file: 'src/App.svelte', line: 3, column: 4 } });
    (el as unknown as Record<string, unknown>)[SVELTE_META_KEY] = { loc: { line: 1 } }; // no file
    expect(getSvelteMeta(el)).toBeUndefined();
  });
});

describe('componentFileForNode', () => {
  it('returns the nearest self-or-ancestor meta file', () => {
    const root = mount((r) => {
      tagMeta(r, 'src/App.svelte');
      const child = document.createElement('span');
      tagMeta(child, 'src/Counter.svelte');
      const leaf = document.createElement('b'); // untagged leaf inside Counter
      child.appendChild(leaf);
      r.appendChild(child);
    });
    const leaf = root.querySelector('b')!;
    expect(componentFileForNode(leaf)).toBe('src/Counter.svelte');
    const untaggedOutside = document.createElement('p');
    expect(componentFileForNode(untaggedOutside)).toBeUndefined();
  });
});

describe('detectSvelte', () => {
  it('reports dev:true when __svelte_meta elements exist', () => {
    mount((r) => {
      const el = document.createElement('span');
      tagMeta(el, 'src/App.svelte');
      r.appendChild(el);
    });
    const d = detectSvelte({}, document);
    expect(d.present).toBe(true);
    expect(d.dev).toBe(true);
    expect(d.metaElementCount).toBeGreaterThanOrEqual(1);
  });

  it('reports present:true dev:false from the global alone (production-like)', () => {
    (globalThis as unknown as Record<string, unknown>)[SVELTE_GLOBAL_KEY] = { v: new Set(['5']) };
    const d = detectSvelte(globalThis as never, document);
    expect(d.present).toBe(true);
    expect(d.dev).toBe(false);
    expect(d.metaElementCount).toBe(0);
  });

  it('reports absent on a non-Svelte page', () => {
    expect(detectSvelte({}, document)).toEqual({
      present: false,
      dev: false,
      metaElementCount: 0,
    });
  });
});

describe('discoverSvelteComponents', () => {
  it('groups rendered DOM by component source file in document order', () => {
    mount((r) => {
      const a1 = document.createElement('div');
      tagMeta(a1, 'src/App.svelte', 1, 0);
      const c1 = document.createElement('span');
      tagMeta(c1, 'src/Counter.svelte', 2, 2);
      const c2 = document.createElement('button');
      tagMeta(c2, 'src/Counter.svelte', 5, 4);
      r.append(a1, c1, c2);
    });
    const comps = discoverSvelteComponents(document);
    expect(comps.map((c) => c.file)).toEqual(['src/App.svelte', 'src/Counter.svelte']);
    const counter = comps.find((c) => c.file === 'src/Counter.svelte')!;
    expect(counter.elementCount).toBe(2);
    expect(counter.stableId).toBe('src/Counter.svelte');
    expect(counter.firstLoc).toEqual({ line: 2, column: 2 });
  });

  it('returns [] when no __svelte_meta is present', () => {
    mount((r) => r.append(document.createElement('div')));
    expect(discoverSvelteComponents(document)).toEqual([]);
  });
});
