import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutFinding, LayoutMeasureResult } from '@pwa-debug/shared';
import type { LayoutGeometry } from '../../src/layout_measure/geometry.js';
import {
  measureLayout,
  readLayoutMeasureInput,
  runLayoutMeasure,
} from '../../src/layout_measure/measure.js';
import { FREEZE_STYLE_ID } from '../../src/layout_measure/freeze.js';
import { contrastRatio, parseCssColor } from '../../src/layout_measure/color.js';

// happy-dom has no layout engine: rects come from data-rect="x y w h",
// scroll sizes from data-scroll="scrollWidth clientWidth", styles from the
// inline style attribute over computed-style defaults.
const INLINE_TAGS = new Set(['A', 'SPAN', 'LABEL', 'B', 'EM', 'STRONG']);
const DEFAULTS: Record<string, string> = {
  'overflow-x': 'visible',
  'overflow-y': 'visible',
  position: 'static',
  visibility: 'visible',
  opacity: '1',
  'background-color': 'rgba(0, 0, 0, 0)',
  'background-image': 'none',
  'box-shadow': 'none',
  'text-overflow': 'clip',
  color: 'rgb(0, 0, 0)',
  'font-size': '16px',
  'font-weight': '400',
};

const nums = (el: Element, attr: string): number[] =>
  (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean).map(Number);

const fakeGeometry = (vp = { width: 360, height: 800 }, docScrollWidth = 360): LayoutGeometry => ({
  rectOf: (el) => {
    const [x = 0, y = 0, width = 0, height = 0] = nums(el, 'data-rect');
    return { x, y, width, height };
  },
  styleOf: (el, prop) => {
    const inline = (el as HTMLElement).style?.getPropertyValue(prop) ?? '';
    if (inline !== '') return inline;
    if (prop === 'display') return INLINE_TAGS.has(el.tagName) ? 'inline' : 'block';
    if (/^border-.*-width$/.test(prop) || /^padding-/.test(prop)) return '0px';
    if (/^border-.*-style$/.test(prop)) return 'none';
    return DEFAULTS[prop] ?? '';
  },
  scrollOf: (el) => {
    const [scrollWidth = 0, clientWidth = 0] = nums(el, 'data-scroll');
    return { scrollWidth, clientWidth };
  },
  viewport: () => vp,
  docScrollWidth: () => docScrollWidth,
  scrollOffset: () => ({ x: 0, y: 0 }),
});

const measure = (
  html: string,
  payload: Record<string, unknown> = {},
  geometry: LayoutGeometry = fakeGeometry(),
): readonly LayoutFinding[] => {
  document.body.innerHTML = html;
  const parsed = readLayoutMeasureInput(payload);
  if (!parsed.ok) throw new Error(parsed.error);
  const r = measureLayout(document, parsed.input, geometry);
  if ('error' in r) throw new Error(r.error.message);
  return r.findings;
};

const only = (findings: readonly LayoutFinding[], check: string) =>
  findings.filter((f) => f.check === check);

afterEach(() => {
  document.body.innerHTML = '';
  document.getElementById(FREEZE_STYLE_ID)?.remove();
});

describe('page_overflow_x', () => {
  it('flags a document wider than the viewport', () => {
    const f = measure('<div data-rect="0 0 360 40"></div>', {}, fakeGeometry(undefined, 420));
    expect(only(f, 'page_overflow_x')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('420px wide in a 360px viewport') }),
    ]);
    expect(only(measure('<div data-rect="0 0 360 40"></div>'), 'page_overflow_x')).toEqual([]);
  });
});

describe('offscreen', () => {
  it('reports only the outermost element crossing the edge', () => {
    const f = only(
      measure('<div class="hero" data-rect="0 0 500 50"><p data-rect="0 0 480 20">wide</p></div>'),
      'offscreen',
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ signature: 'div.hero "wide"', message: expect.stringContaining('140px past the right edge') });
  });

  it('skips content inside a horizontally scrolling row', () => {
    const html = `<div style="overflow-x:auto" data-rect="0 0 360 40" data-scroll="800 360">
      <span class="chip" data-rect="300 0 120 30">Chip</span></div>`;
    expect(only(measure(html), 'offscreen')).toEqual([]);
  });

  it('skips parked off-canvas drawers and exempt elements', () => {
    const drawer = '<nav style="position:fixed" data-rect="-300 0 300 800">Menu</nav>';
    expect(only(measure(drawer), 'offscreen')).toEqual([]);
    const exempt = '<div class="ticker" data-rect="0 0 600 20">news</div>';
    expect(only(measure(exempt, { exempt_selectors: ['.ticker'] }), 'offscreen')).toEqual([]);
  });
});

describe('tap_target', () => {
  it('flags a standalone small link and honors a custom min', () => {
    const html = '<p data-rect="0 0 360 21"><a href="#" data-rect="0 0 304 21">New here? Create an account</a></p>';
    expect(only(measure(html), 'tap_target')).toEqual([
      expect.objectContaining({ message: 'tap target 304×21 "New here? Create an account" (min 24)' }),
    ]);
    const big = '<button data-rect="0 0 40 40">Go</button>';
    expect(only(measure(big), 'tap_target')).toEqual([]);
    expect(only(measure(big, { checks: { tap_target: { min: 44 } } }), 'tap_target')).toHaveLength(1);
  });

  it('exempts links inline in a sentence', () => {
    const html = '<p data-rect="0 0 360 20">Read our <a href="#" data-rect="70 0 40 18">terms</a> first.</p>';
    expect(only(measure(html), 'tap_target')).toEqual([]);
  });

  it('measures a checkbox by its wrapping label', () => {
    const html = '<label data-rect="0 0 200 32"><input type="checkbox" data-rect="0 8 16 16"> Remember me</label>';
    expect(only(measure(html), 'tap_target')).toEqual([]);
    const small = '<label data-rect="0 0 120 18"><input type="checkbox" data-rect="0 1 16 16"> Remember</label>';
    expect(only(measure(small), 'tap_target')).toEqual([
      expect.objectContaining({ signature: expect.stringMatching(/^label/) }),
    ]);
  });
});

describe('pinned_visible', () => {
  it('flags a fixed bar pushed partly below the viewport', () => {
    const html = '<div class="tabbar" style="position:fixed" data-rect="0 780 360 56">Tabs</div>';
    expect(only(measure(html), 'pinned_visible')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('36px below the bottom edge') }),
    ]);
  });

  it('treats a fixed element fully off screen as parked unless a pinned selector names it', () => {
    const html = '<div class="sheet" style="position:fixed" data-rect="0 900 360 300">Sheet</div>';
    expect(only(measure(html), 'pinned_visible')).toEqual([]);
    const named = measure(html, { checks: { pinned_visible: { pinned_selectors: ['.sheet'] } } });
    expect(only(named, 'pinned_visible')).toHaveLength(1);
  });
});

describe('text_clipped', () => {
  it('flags an ellipsized label that needs more room', () => {
    const html = '<button style="text-overflow:ellipsis;overflow-x:hidden" data-rect="0 0 120 44" data-scroll="180 120">Crear una cuenta nueva</button>';
    expect(only(measure(html), 'text_clipped')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('needs 180px, has 120px') }),
    ]);
    const fits = '<button style="text-overflow:ellipsis" data-rect="0 0 120 44" data-scroll="120 120">OK</button>';
    expect(only(measure(fits), 'text_clipped')).toEqual([]);
  });
});

describe('edge_contact', () => {
  it('flags text touching the inner edge of a card whose padding was zeroed', () => {
    const html = `<div class="card" style="background-color:rgb(255, 255, 255)" data-rect="16 100 328 80">
      <p data-rect="16 110 328 20">Order summary</p></div>`;
    expect(only(measure(html), 'edge_contact')).toEqual([
      expect.objectContaining({
        signature: expect.stringMatching(/^div\.card/),
        message: 'text "Order summary" is 0px from the left edge of its box (min 4)',
      }),
    ]);
  });

  it('passes a padded card and lets text sit inside its own padding', () => {
    const padded = `<div class="card" style="background-color:rgb(255, 255, 255)" data-rect="16 100 328 80">
      <p data-rect="32 116 296 20">Order summary</p></div>`;
    expect(only(measure(padded), 'edge_contact')).toEqual([]);
    const ownPadding = `<div class="card" style="border:1px solid rgb(0, 0, 0)" data-rect="16 100 328 80">
      <p style="padding:0 12px" data-rect="17 110 326 20">Order summary</p></div>`;
    expect(only(measure(ownPadding), 'edge_contact')).toEqual([]);
  });

  it('flags a field flush with the top of its sheet', () => {
    const html = `<section class="sheet" style="box-shadow:0 1px 2px rgb(0, 0, 0)" data-rect="0 400 360 300">
      <input placeholder="Email" data-rect="16 400 328 44"></section>`;
    expect(only(measure(html), 'edge_contact')).toEqual([
      expect.objectContaining({ message: 'control "Email" is 0px from the top edge of its box (min 4)' }),
    ]);
  });
});

describe('text_patterns', () => {
  it('finds unresolved copy, including caller patterns', () => {
    const html = '<p data-rect="0 0 360 20">Hi {{ name }}, total undefined [auth:sign_in.title]</p>';
    const f = only(measure(html, { checks: { text_patterns: { extra: ['\\[[a-z-]+:[\\w.]+\\]'] } } }), 'text_patterns');
    expect(f.map((x) => x.signature)).toEqual([
      'text "{{ name }}"',
      'text "undefined"',
      'text "[auth:sign_in.title]"',
    ]);
  });
});

describe('contrast', () => {
  it('is off by default and flags low-contrast text when enabled', () => {
    const html = '<p style="color:rgb(170, 170, 170)" data-rect="0 0 360 20">Faint hint</p>';
    expect(only(measure(html), 'contrast')).toEqual([]);
    expect(only(measure(html, { checks: { contrast: true } }), 'contrast')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('(needs 4.5:1; approximate)') }),
    ]);
    const ok = '<p data-rect="0 0 360 20">Black on white</p>';
    expect(only(measure(ok, { checks: { contrast: true } }), 'contrast')).toEqual([]);
  });
});

describe('payload handling', () => {
  it('rejects bad ops, invalid selectors and a missing root', () => {
    expect(readLayoutMeasureInput({ op: 'nope' }).ok).toBe(false);
    document.body.innerHTML = '<div></div>';
    const bad = runLayoutMeasure(window, { exempt_selectors: ['[[['] }, fakeGeometry());
    expect(bad).toEqual({ error: { message: expect.stringContaining('invalid CSS selector') } });
    const missing = runLayoutMeasure(window, { root_selector: '.phone' }, fakeGeometry());
    expect(missing).toEqual({ error: { message: expect.stringContaining('matched nothing') } });
  });

  it('scopes to root_selector and reports the viewport', () => {
    document.body.innerHTML =
      '<div data-rect="0 0 600 20">outside</div><div class="phone" data-rect="0 0 360 800"><p data-rect="0 0 100 20">in</p></div>';
    const r = runLayoutMeasure(window, { root_selector: '.phone' }, fakeGeometry()) as LayoutMeasureResult;
    expect(r.viewport).toEqual({ width: 360, height: 800 });
    expect(only(r.findings, 'offscreen')).toEqual([]);
  });

  it('installs and removes the animation freeze', () => {
    expect(runLayoutMeasure(window, { op: 'freeze' })).toEqual({ frozen: true });
    expect(runLayoutMeasure(window, { op: 'freeze' })).toEqual({ frozen: true });
    expect(document.querySelectorAll(`#${FREEZE_STYLE_ID}`)).toHaveLength(1);
    expect(runLayoutMeasure(window, { op: 'unfreeze' })).toEqual({ frozen: false });
    expect(document.getElementById(FREEZE_STYLE_ID)).toBeNull();
  });
});

describe('color', () => {
  it('parses rgb, rgba, space syntax and hex', () => {
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseCssColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('oklch(0.5 0.1 200)')).toBeNull();
  });

  it('computes WCAG contrast', () => {
    const black = parseCssColor('#000') ?? { r: 0, g: 0, b: 0, a: 1 };
    const white = parseCssColor('#fff') ?? { r: 255, g: 255, b: 255, a: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
  });
});
