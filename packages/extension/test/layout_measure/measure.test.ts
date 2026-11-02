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
  'outline-style': 'none',
  'outline-width': '0px',
  'outline-offset': '0px',
  clip: 'auto',
  'clip-path': 'none',
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
  // data-scroll="scrollWidth clientWidth scrollHeight clientHeight scrollLeft scrollTop"
  scrollOf: (el) => {
    const [scrollWidth = 0, clientWidth = 0, scrollHeight = 0, clientHeight = 0, scrollLeft = 0, scrollTop = 0] =
      nums(el, 'data-scroll');
    return { scrollWidth, clientWidth, scrollHeight, clientHeight, scrollLeft, scrollTop };
  },
  isRendered: () => true,
  // data-ink="x y w h" stands in for the element's text line boxes (none by default).
  textRectsOf: (el) => {
    const [x, y, width, height] = nums(el, 'data-ink');
    return x === undefined ? [] : [{ x, y: y ?? 0, width: width ?? 0, height: height ?? 0 }];
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
    const html = `<main style="background-color:rgb(240, 240, 240)">
      <div class="card" style="background-color:rgb(255, 255, 255)" data-rect="16 100 328 80">
      <p data-rect="16 110 328 20">Order summary</p></div></main>`;
    expect(only(measure(html), 'edge_contact')).toEqual([
      expect.objectContaining({
        signature: expect.stringMatching(/^div\.card/),
        message: 'text "Order summary" is 0px from the left edge of its box (min 4)',
      }),
    ]);
  });

  it('passes a padded card and lets text sit inside its own padding', () => {
    const padded = `<main style="background-color:rgb(240, 240, 240)">
      <div class="card" style="background-color:rgb(255, 255, 255)" data-rect="16 100 328 80">
      <p data-rect="32 116 296 20">Order summary</p></div></main>`;
    expect(only(measure(padded), 'edge_contact')).toEqual([]);
    const ownPadding = `<div class="card" style="border:1px solid rgb(0, 0, 0)" data-rect="16 100 328 80">
      <p style="padding:0 12px" data-rect="17 110 326 20">Order summary</p></div>`;
    expect(only(measure(ownPadding), 'edge_contact')).toEqual([]);
  });

  it('flags a field flush with the top of its sheet', () => {
    const html = `<section class="sheet" style="box-shadow:0 1px 2px rgb(0, 0, 0)" data-rect="0 400 360 300">
      <input placeholder="Email" style="border:1px solid rgb(0, 0, 0)" data-rect="16 400 328 44"></section>`;
    expect(only(measure(html), 'edge_contact')).toEqual([
      expect.objectContaining({ message: 'control "Email" is 0px from the top edge of its box (min 4)' }),
    ]);
  });
});

describe('edge_contact: only edges a viewer can see', () => {
  const card = (inner: string, pad = 16): string => `<main style="background-color:rgb(240, 240, 240)">
    <div class="card" style="background-color:rgb(255, 255, 255)" data-rect="16 100 328 200">
    ${inner.replaceAll('PAD', String(16 + pad))}</div></main>`;

  it('judges a divider-only or same-color row by the padded card around it', () => {
    const divider = card(`<div class="row" style="border-bottom:1px solid rgb(220, 220, 220)" data-rect="PAD 120 296 40">
      <span data-rect="PAD 130 80 20">Total</span></div>`);
    expect(only(measure(divider), 'edge_contact')).toEqual([]);
    const sameColor = card(`<div class="row" style="background-color:rgb(255, 255, 255)" data-rect="PAD 120 296 40">
      <span data-rect="PAD 130 80 20">Total</span></div>`);
    expect(only(measure(sameColor), 'edge_contact')).toEqual([]);
  });

  it('judges a footer button by the card, skips full-bleed buttons, and still catches a zeroed card', () => {
    const btn = 'background-color:rgb(37, 99, 235)';
    const footer = (pad: number, width: number): string =>
      card(`<div class="footer" style="background-color:rgb(255, 255, 255)" data-rect="PAD 240 ${328 - 2 * pad} 44">
      <button style="${btn}" data-rect="PAD 240 ${width} 44">Pay now</button></div>`, pad);
    expect(only(measure(footer(16, 296)), 'edge_contact')).toEqual([]);
    // Spans the whole card: a full-bleed action, by design.
    expect(only(measure(footer(0, 328)), 'edge_contact')).toEqual([]);
    expect(only(measure(footer(0, 200)), 'edge_contact')).toEqual([
      expect.objectContaining({
        signature: expect.stringMatching(/^div\.card/),
        message: 'control "Pay now" is 0px from the left edge of its box (min 4)',
      }),
    ]);
  });

  it('measures edge-less controls by what they draw, and lets edged controls sit a few px in', () => {
    const toast = `<main style="background-color:rgb(240, 240, 240)">
      <div class="toast" style="background-color:rgb(255, 255, 255)" data-rect="16 96 328 50">
      <span data-rect="32 110 200 20" data-ink="32 110 150 20">Order arrived</span>
      <button data-rect="270 99 60 44" data-ink="282 112 36 18">Undo</button></div></main>`;
    expect(only(measure(toast), 'edge_contact')).toEqual([]);
    const segmented = (inset: number): string => `<main style="background-color:rgb(240, 240, 240)">
      <div class="segmented" style="background-color:rgb(230, 235, 235)" data-rect="20 170 320 54">
      <button style="background-color:rgb(255, 255, 255)" data-rect="${20 + inset} ${170 + inset} 80 ${54 - 2 * inset}">6 mo</button>
      <button data-rect="100 170 80 54" data-ink="120 186 40 20">1 yr</button></div></main>`;
    expect(only(measure(segmented(2)), 'edge_contact')).toEqual([]);
    expect(only(measure(segmented(0)), 'edge_contact')).toEqual([
      expect.objectContaining({ message: 'control "6 mo" is 0px from the left edge of its box (min 4)' }),
    ]);
  });

  it('still measures a row that shows its own surface', () => {
    const tinted = card(`<div class="row" style="background-color:rgb(250, 230, 200)" data-rect="PAD 120 296 40">
      <span data-rect="PAD 130 80 20">Total</span></div>`);
    expect(only(measure(tinted), 'edge_contact')).toEqual([
      expect.objectContaining({ signature: expect.stringMatching(/^div\.row/) }),
    ]);
  });

  it('measures text where it is drawn: a block spanning the box with shorter lines passes', () => {
    const banner = (ink: string): string => `<main style="background-color:rgb(240, 240, 240)">
      <div class="capacity" style="border:1px solid rgb(200, 200, 200)" data-rect="20 64 305 93">
      <strong data-rect="45 76 279 40" data-ink="${ink}">Kitchens and drivers are available</strong></div></main>`;
    expect(only(measure(banner('45 76 263 40')), 'edge_contact')).toEqual([]);
    expect(only(measure(banner('45 76 278 40')), 'edge_contact')).toEqual([
      expect.objectContaining({ message: 'text "Kitchens and drivers are available" is 1px from the right edge of its box (min 4)' }),
    ]);
  });

  it('compares whole pixels, so 3.6px passes a 4px minimum and 3.4px reports 3px', () => {
    const at = (x: number): string => card(`<p data-rect="${16 + x} 120 200 20">Order summary</p>`, 0);
    expect(only(measure(at(3.6)), 'edge_contact')).toEqual([]);
    expect(only(measure(at(3.4)), 'edge_contact')).toEqual([
      expect.objectContaining({ message: 'text "Order summary" is 3px from the left edge of its box (min 4)' }),
    ]);
  });

  it('skips content in a closed <details> and content scrolled away inside a scroller', () => {
    const details = (open: boolean): string =>
      card(`<details ${open ? 'open' : ''} data-rect="32 120 296 40"><summary data-rect="32 120 296 40">More</summary>
      <p data-rect="16 90 100 20">Hidden fee</p></details>`);
    expect(only(measure(details(false)), 'edge_contact')).toEqual([]);
    expect(only(measure(details(true)), 'edge_contact')).toHaveLength(1);
    const scrolled = card(`<div class="list" style="overflow-y:auto;overflow-x:hidden" data-rect="32 116 296 160">
      <p data-rect="32 60 296 20">Earlier item</p></div>`);
    expect(only(measure(scrolled), 'edge_contact')).toEqual([]);
  });
});

describe('visually hidden content', () => {
  const srOnly = 'position:absolute;width:1px;height:1px;overflow-x:hidden;overflow-y:hidden;clip:rect(0px, 0px, 0px, 0px)';

  it('does not report screen-reader-only labels as cut off or as small targets', () => {
    const html = `<button data-rect="16 16 44 44"><span style="${srOnly}" data-rect="16 16 1 1" data-scroll="60 1">Close menu</span></button>
      <a href="#main" style="${srOnly}" data-rect="0 0 1 1">Skip to content</a>`;
    const f = measure(html);
    expect(only(f, 'text_clipped')).toEqual([]);
    expect(only(f, 'tap_target')).toEqual([]);
  });

  it('treats clip-path: inset(50%) as hidden, including descendants', () => {
    const html = `<div style="clip-path:inset(50%);overflow-x:hidden" data-rect="0 0 100 20" data-scroll="300 100">
      <a href="#x" data-rect="0 0 80 10">Skip</a>Long hidden label text</div>`;
    const f = measure(html);
    expect(only(f, 'text_clipped')).toEqual([]);
    expect(only(f, 'tap_target')).toEqual([]);
  });

  it('still reports a real ellipsized label', () => {
    const html = '<button style="text-overflow:ellipsis;overflow-x:hidden" data-rect="0 0 120 44" data-scroll="180 120">Crear una cuenta nueva</button>';
    expect(only(measure(html), 'text_clipped')).toHaveLength(1);
  });
});

describe('ring_clipped', () => {
  const ring = 'box-shadow:rgb(37, 99, 235) 0px 0px 0px 2px';
  const row = (chipX: number, scroll = '500 360 40 40 0 0'): string =>
    `<div class="chips" style="overflow-x:auto;overflow-y:hidden" data-rect="0 100 360 40" data-scroll="${scroll}">
      <button style="${ring}" data-rect="${chipX} 104 80 32">All</button></div>`;

  it('flags a selection ring cut off by a scrolling row', () => {
    expect(only(measure(row(0)), 'ring_clipped')).toEqual([
      expect.objectContaining({
        signature: expect.stringMatching(/^button "All"/),
        message: 'box-shadow of "All" cut off 2px of 2px on the left by div.chips (overflow-x: auto)',
      }),
    ]);
  });

  it('passes a row with room for the ring, and a ring that scrolling reveals', () => {
    expect(only(measure(row(8)), 'ring_clipped')).toEqual([]);
    // Right edge of the visible area, but the row scrolls on to 500px: not a permanent cut.
    const midRow = `<div class="chips" style="overflow-x:auto;overflow-y:hidden" data-rect="0 100 360 40" data-scroll="500 360 40 40 0 0">
      <button style="${ring}" data-rect="280 104 80 32">Pets</button></div>`;
    expect(only(measure(midRow), 'ring_clipped')).toEqual([]);
  });

  it('flags the last chip at the end of the scroll range', () => {
    const scrolledEnd = `<div class="chips" style="overflow-x:auto;overflow-y:hidden" data-rect="0 100 360 40" data-scroll="500 360 40 40 140 0">
      <button style="${ring}" data-rect="280 104 80 32">Pets</button></div>`;
    expect(only(measure(scrolledEnd), 'ring_clipped')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('2px of 2px on the right') }),
    ]);
  });

  it('flags an outline cut by an overflow-hidden parent and ignores transparent shadow layers', () => {
    const outline = `<div class="list" style="overflow-x:hidden;overflow-y:hidden" data-rect="0 0 360 200">
      <a href="#" style="outline-style:solid;outline-width:2px;outline-offset:2px" data-rect="16 0 100 44">Inbox</a></div>`;
    expect(only(measure(outline), 'ring_clipped')).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/^outline of "Inbox" cut off 4px of 4px on the top/) }),
    ]);
    const tw = `<div style="overflow-x:hidden;overflow-y:hidden" data-rect="0 0 360 200">
      <button style="box-shadow:rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 3px" data-rect="0 0 100 44">Go</button></div>`;
    expect(only(measure(tw), 'ring_clipped')).toEqual([]);
  });

  it('lets the nearest scroller decide, and skips full-span panels', () => {
    // The card sits at the bottom of the phone, but inside a scroller with room below it.
    const nested = `<div class="phone" style="overflow-x:hidden;overflow-y:hidden" data-rect="0 0 360 800" data-scroll="360 360 800 800 0 0">
      <div class="body" style="overflow-x:hidden;overflow-y:auto" data-rect="0 0 360 800" data-scroll="360 360 1300 800 0 0">
      <div class="card" style="box-shadow:rgba(14, 94, 99, 0.35) 0px 10px 24px -14px" data-rect="20 650 320 146">Settings</div></div></div>`;
    expect(only(measure(nested), 'ring_clipped')).toEqual([]);
    const panel = `<div class="phone" style="overflow-x:hidden;overflow-y:hidden" data-rect="0 0 360 800">
      <div class="op-panel" style="box-shadow:rgb(0, 0, 0) 0px 0px 28px 0px" data-rect="0 120 360 360">Progress</div></div>`;
    expect(only(measure(panel), 'ring_clipped')).toEqual([]);
  });

  it('ignores a static clipper an absolutely positioned element escapes, and honors min_px', () => {
    const escaped = `<div style="position:relative" data-rect="0 0 360 200">
      <div style="overflow-x:hidden;overflow-y:hidden" data-rect="0 0 360 200">
      <span style="position:absolute;${ring}" data-rect="0 0 20 20">3</span></div></div>`;
    expect(only(measure(escaped), 'ring_clipped')).toEqual([]);
    expect(only(measure(row(0), { checks: { ring_clipped: { min_px: 3 } } }), 'ring_clipped')).toEqual([]);
  });
});

describe('custom checks', () => {
  const run = (html: string, custom: readonly { name: string; expression: string }[], extra: Record<string, unknown> = {}) => {
    document.body.innerHTML = html;
    const parsed = readLayoutMeasureInput({ custom, view: { width: '360', scheme: 'dark', state: 'open' }, ...extra });
    if (!parsed.ok) throw new Error(parsed.error);
    const r = measureLayout(document, parsed.input, fakeGeometry());
    if ('error' in r) throw new Error(r.error.message);
    return r;
  };
  const page = `<p class="price" data-rect="16 16 100 40">$12.00</p>
    <p class="price" data-rect="16 60 100 20">$3.50</p>
    <p class="price" style="display:none" data-rect="16 90 100 40">$9.99</p>
    <p class="price skip" data-rect="16 140 100 40">$1.00</p>`;

  it('turns returned elements into custom:<name> findings, using pdl visibility and exemptions', () => {
    const r = run(page, [{ name: 'price_wraps', expression: "pdl.elements('.price').filter(e => pdl.rect(e).height > 30)" }], {
      exempt_selectors: ['.skip'],
    });
    expect(r.findings.filter((f) => f.check.startsWith('custom:'))).toEqual([
      {
        check: 'custom:price_wraps',
        signature: 'p.price "$12.00"',
        message: 'price_wraps: "$12.00"',
        rect: { x: 16, y: 16, width: 100, height: 40 },
      },
    ]);
    expect(r.custom_errors).toBeUndefined();
  });

  it('binds view, and accepts strings, { element, message, signature } items and NodeLists', () => {
    const r = run(page, [
      { name: 'by_view', expression: "view.scheme === 'dark' ? `dark at ${view.width}` : null" },
      { name: 'items', expression: "[{ element: document.querySelector('.price'), message: 'custom text', signature: 'price row' }, { message: 'page-level note' }]" },
      { name: 'nodes', expression: "document.querySelectorAll('.price.skip')" },
    ]);
    const custom = r.findings.filter((f) => f.check.startsWith('custom:'));
    expect(custom).toEqual([
      { check: 'custom:by_view', signature: 'text "dark at 360"', message: 'dark at 360' },
      expect.objectContaining({ check: 'custom:items', signature: 'price row', message: 'custom text' }),
      { check: 'custom:items', signature: 'page-level note', message: 'page-level note' },
      expect.objectContaining({ check: 'custom:nodes', signature: 'p.price.skip "$1.00"' }),
    ]);
  });

  it('reports throws, compile errors, promises and bad items per check without losing the rest', () => {
    const r = run(page, [
      { name: 'throws', expression: 'missing.thing' },
      { name: 'broken', expression: 'pdl.elements(' },
      { name: 'async_one', expression: 'Promise.resolve([])' },
      { name: 'mixed', expression: "[document.querySelector('.price'), 42]" },
      { name: 'fine', expression: "'ok'" },
    ]);
    expect(r.custom_errors).toEqual([
      { name: 'throws', error: expect.stringContaining('ReferenceError') },
      { name: 'broken', error: expect.stringContaining('SyntaxError') },
      { name: 'async_one', error: 'returned a promise; custom checks must return synchronously' },
      { name: 'mixed', error: 'item 1 is not an element, a string or { element?, message, signature? }' },
    ]);
    expect(r.findings.filter((f) => f.check.startsWith('custom:')).map((f) => f.check)).toEqual(['custom:mixed', 'custom:fine']);
  });

  it('caps findings per check and rejects invalid custom payloads', () => {
    const r = run('<p data-rect="0 0 10 10">x</p>', [{ name: 'many', expression: 'Array.from({ length: 150 }, (_, i) => `n${i}`)' }]);
    expect(r.findings.filter((f) => f.check === 'custom:many')).toHaveLength(100);
    expect(r.custom_errors).toEqual([{ name: 'many', error: 'returned 150 findings; kept 100' }]);
    expect(readLayoutMeasureInput({ custom: [{ name: 'Bad', expression: '1' }] }).ok).toBe(false);
    expect(readLayoutMeasureInput({ view: { width: 360 } }).ok).toBe(false);
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
