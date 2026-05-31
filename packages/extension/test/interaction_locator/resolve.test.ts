import { describe, it, expect } from 'vitest';
import { bySelector, byRole, byText } from '../../src/interaction_locator/strategies.js';
import { selectMatch, resolveLocator } from '../../src/interaction_locator/resolve.js';
import { resolveByStableId } from '../../src/interaction_locator/stable_id.js';
import type { Locator } from '../../src/interaction_locator/types.js';

const mount = (html: string): void => {
  document.body.innerHTML = html;
};

describe('strategies', () => {
  it('bySelector returns matches and [] on an invalid selector', () => {
    mount('<button class="x"></button><button class="x"></button>');
    expect(bySelector(document, 'button.x')).toHaveLength(2);
    expect(bySelector(document, '((')).toEqual([]);
  });

  it('byRole matches role and narrows by accessible name', () => {
    mount('<button aria-label="Save">S</button><a href="#">link</a>');
    expect(byRole(document, 'button')).toHaveLength(1);
    expect(byRole(document, 'button', /Save/)).toHaveLength(1);
    expect(byRole(document, 'button', /Nope/)).toHaveLength(0);
    expect(byRole(document, 'link')).toHaveLength(1);
  });

  it('byText matches the leaf-most element holding the text', () => {
    mount('<div>outer<span>Hello</span></div>');
    const sub = byText(document, /Hello/);
    expect(sub).toHaveLength(1);
    expect(sub[0]!.tagName).toBe('SPAN');
    expect(byText(document, /^Hello$/)).toHaveLength(1);
    expect(byText(document, /^outer$/)[0]!.tagName).toBe('DIV');
  });
});

describe('selectMatch', () => {
  const els = (): Element[] => {
    mount('<i id="0"></i><i id="1"></i><i id="2"></i>');
    return Array.from(document.querySelectorAll('i'));
  };
  const loc = (o: Partial<Locator> = {}): Locator => o;

  it('defaults to the first of N', () => {
    const r = selectMatch(els(), loc(), 'd');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.element.id).toBe('0');
      expect(r.matchCount).toBe(3);
    }
  });

  it('honors nth and rejects out-of-range', () => {
    const list = els();
    const r = selectMatch(list, loc({ nth: 2 }), 'd');
    expect(r.ok && r.element.id).toBe('2');
    expect(selectMatch(list, loc({ nth: 9 }), 'd').ok).toBe(false);
  });

  it('requireUnique errors on ambiguity', () => {
    expect(selectMatch(els(), loc({ requireUnique: true }), 'd').ok).toBe(false);
  });

  it('not-found on empty', () => {
    const r = selectMatch([], loc(), 'd');
    expect(r.ok).toBe(false);
    expect(r.matchCount).toBe(0);
  });
});

describe('resolveByStableId', () => {
  it('treats a solid stableId as a CSS selector', () => {
    mount('<button id="go"></button>');
    expect(resolveByStableId(document, 'solid', '#go')).toHaveLength(1);
  });

  it('returns nothing for svelte (file-level identity)', () => {
    mount('<button id="go"></button>');
    expect(resolveByStableId(document, 'svelte', 'Foo.svelte')).toEqual([]);
  });
});

describe('resolveLocator', () => {
  it('selector beats role in precedence', () => {
    mount('<button id="b">x</button>');
    const r = resolveLocator(document, { selector: '#b', role: 'heading' });
    expect(r.ok && r.element.id).toBe('b');
  });

  it('svelte stableId returns a guided error', () => {
    const r = resolveLocator(document, { framework: 'svelte', stableId: 'Foo.svelte' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/svelte/i);
  });

  it('solid stableId resolves via selector', () => {
    mount('<button id="go"></button>');
    const r = resolveLocator(document, { framework: 'solid', stableId: '#go' });
    expect(r.ok && r.element.id).toBe('go');
  });

  it('reports not-found with matchCount 0', () => {
    mount('<div></div>');
    const r = resolveLocator(document, { selector: '.none' });
    expect(r.ok).toBe(false);
    expect(r.matchCount).toBe(0);
  });
});
