import type { LayoutRect } from '@pwa-debug/shared';

export type ScrollMetrics = {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
};

/**
 * The DOM reads the layout checks need, injectable so tests can supply rects
 * (happy-dom has no layout engine). domGeometry is the real implementation.
 */
export type LayoutGeometry = {
  readonly rectOf: (el: Element) => LayoutRect;
  readonly styleOf: (el: Element, prop: string) => string;
  readonly scrollOf: (el: Element) => ScrollMetrics;
  /**
   * False when the engine skips rendering el (display:none or
   * content-visibility:hidden ancestors, e.g. a closed <details>). Layout
   * reads there force a layout and return real-looking rects.
   */
  readonly isRendered: (el: Element) => boolean;
  /**
   * Line boxes of el's own (direct, non-blank) text nodes: where its text is
   * actually drawn. A block's rect spans its container; its text may not.
   */
  readonly textRectsOf: (el: Element) => readonly LayoutRect[];
  /** Layout viewport in CSS px (what device-metrics emulation sets). */
  readonly viewport: () => { readonly width: number; readonly height: number };
  readonly docScrollWidth: () => number;
  readonly scrollOffset: () => { readonly x: number; readonly y: number };
};

export const domGeometry = (win: Window): LayoutGeometry => ({
  rectOf: (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  },
  styleOf: (el, prop) => win.getComputedStyle(el).getPropertyValue(prop),
  scrollOf: (el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollLeft: el.scrollLeft,
    scrollTop: el.scrollTop,
  }),
  isRendered: (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true),
  textRectsOf: (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0)
      .flatMap((n) => {
        const range = win.document.createRange();
        range.selectNodeContents(n);
        return [...range.getClientRects()]
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
      }),
  viewport: () => {
    const de = win.document.documentElement;
    return {
      width: de.clientWidth > 0 ? de.clientWidth : win.innerWidth,
      height: de.clientHeight > 0 ? de.clientHeight : win.innerHeight,
    };
  },
  docScrollWidth: () => win.document.documentElement.scrollWidth,
  scrollOffset: () => ({ x: win.scrollX, y: win.scrollY }),
});

type HiddenReads = {
  readonly rect: (el: Element) => LayoutRect;
  readonly style: (el: Element, prop: string) => string;
  readonly px: (el: Element, prop: string) => number;
};

const LENGTH = /-?\d*\.?\d+/g;

/** clip: rect(top, right, bottom, left) with no area (auto edges keep their side). */
const zeroAreaClip = (clip: string): boolean => {
  const m = /^rect\((.*)\)$/.exec(clip);
  if (m === null) return false;
  const parts = (m[1] ?? '').split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 4 || parts.includes('auto')) return false;
  const [t, r, b, l] = parts.map(parseFloat) as [number, number, number, number];
  return r - l <= 1 || b - t <= 1;
};

/** clip-path that removes the whole box: inset(50%) and friends, circle(0) / ellipse(0 0). */
const fullClipPath = (cp: string): boolean => {
  const inset = /^inset\(([^)]*)\)/.exec(cp);
  if (inset !== null) {
    const parts = (inset[1] ?? '').split(/\s+round\s+/)[0]?.split(/\s+/).filter(Boolean) ?? [];
    const pct = parts.map((p) => (p.endsWith('%') ? parseFloat(p) : NaN));
    const [t = NaN, r = t, b = t, l = r] = pct;
    return t + b >= 100 || l + r >= 100;
  }
  const shape = /^(circle|ellipse)\(([^)]*)\)/.exec(cp);
  if (shape === null) return false;
  const radii = (shape[2] ?? '').split(/\s+at\s+/)[0] ?? '';
  const nums = radii.match(LENGTH) ?? [];
  return nums.length > 0 && nums.every((n) => parseFloat(n) === 0);
};

/**
 * Visually hidden on purpose (the sr-only / visually-hidden pattern): a 1×1
 * box that hides its overflow, a zero-area clip on a positioned box, or a
 * clip-path that removes the whole box. Screen readers still read it.
 */
export const isVisuallyHidden = (ctx: HiddenReads, el: Element): boolean => {
  const r = ctx.rect(el);
  const hidesOverflow = /^(hidden|clip)$/.test(ctx.style(el, 'overflow-x')) || /^(hidden|clip)$/.test(ctx.style(el, 'overflow-y'));
  if (r.width <= 1 && r.height <= 1 && hidesOverflow) return true;
  const positioned = /^(absolute|fixed)$/.test(ctx.style(el, 'position'));
  if (positioned && zeroAreaClip(ctx.style(el, 'clip'))) return true;
  return fullClipPath(ctx.style(el, 'clip-path'));
};

/** Memoized reads plus the per-measure predicates every check shares. */
export type MeasureContext = {
  readonly root: Element;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly rect: (el: Element) => LayoutRect;
  readonly style: (el: Element, prop: string) => string;
  readonly scroll: (el: Element) => ScrollMetrics;
  /** Bounds of el's own drawn text (its line boxes), or null when it has none to measure. */
  readonly textInk: (el: Element) => LayoutRect | null;
  readonly px: (el: Element, prop: string) => number;
  readonly isVisible: (el: Element) => boolean;
  readonly isExempt: (el: Element) => boolean;
  readonly isAriaHidden: (el: Element) => boolean;
};

/** Memoize a one-argument read for the duration of one measurement. */
export const memo1 = <K extends object, V>(fn: (k: K) => V): ((k: K) => V) => {
  const cache = new WeakMap<K, V>();
  return (k) => {
    if (cache.has(k)) return cache.get(k) as V;
    const v = fn(k);
    cache.set(k, v);
    return v;
  };
};

/**
 * Build the context for one measurement. Reads are cached for the duration of
 * the call (a view's layout doesn't change while it is measured); nothing is
 * written to the page.
 */
export const createMeasureContext = (
  geometry: LayoutGeometry,
  root: Element,
  exemptSelectors: readonly string[],
): MeasureContext => {
  const styleCache = new WeakMap<Element, Map<string, string>>();
  const style = (el: Element, prop: string): string => {
    const m = styleCache.get(el) ?? new Map<string, string>();
    if (!styleCache.has(el)) styleCache.set(el, m);
    const hit = m.get(prop);
    if (hit !== undefined) return hit;
    const v = geometry.styleOf(el, prop).trim();
    m.set(prop, v);
    return v;
  };
  const rect = memo1((el: Element) => geometry.rectOf(el));
  const scroll = memo1((el: Element) => geometry.scrollOf(el));
  const textInk = memo1((el: Element): LayoutRect | null => {
    const rs = geometry.textRectsOf(el);
    if (rs.length === 0) return null;
    const x = Math.min(...rs.map((r) => r.x));
    const y = Math.min(...rs.map((r) => r.y));
    const right = Math.max(...rs.map((r) => r.x + r.width));
    const bottom = Math.max(...rs.map((r) => r.y + r.height));
    return { x, y, width: right - x, height: bottom - y };
  });
  const px = (el: Element, prop: string): number => {
    const n = parseFloat(style(el, prop));
    return Number.isFinite(n) ? n : 0;
  };
  // Closed <details>: everything but its summary is hidden, at any depth.
  const inClosedDetails = memo1((el: Element): boolean => {
    const parent = el.parentElement;
    if (parent === null) return false;
    const closed = parent.tagName === 'DETAILS' && !parent.hasAttribute('open');
    return (closed && el.tagName !== 'SUMMARY') || inClosedDetails(parent);
  });
  const ctxForHidden = { rect, style, px };
  const inVisuallyHidden = memo1((el: Element): boolean => {
    if (isVisuallyHidden(ctxForHidden, el)) return true;
    const parent = el.parentElement;
    return parent !== null && inVisuallyHidden(parent);
  });
  const isVisible = memo1((el: Element): boolean => {
    const r = rect(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      style(el, 'display') !== 'none' &&
      style(el, 'visibility') !== 'hidden' &&
      style(el, 'opacity') !== '0' &&
      geometry.isRendered(el) &&
      !inClosedDetails(el) &&
      !inVisuallyHidden(el)
    );
  });
  const isExempt = memo1((el: Element): boolean =>
    exemptSelectors.some((sel) => el.closest(sel) !== null),
  );
  const isAriaHidden = memo1(
    (el: Element): boolean => el.closest('[aria-hidden="true"],[inert]') !== null,
  );
  return {
    root,
    viewport: geometry.viewport(),
    rect,
    style,
    scroll,
    textInk,
    px,
    isVisible,
    isExempt,
    isAriaHidden,
  };
};

/** Ancestors of el up to and including stop (exclusive of el). */
export const ancestorsWithin = (el: Element, stop: Element): readonly Element[] => {
  const up = (node: Element | null, acc: readonly Element[]): readonly Element[] =>
    node === null ? acc : node === stop ? [...acc, node] : up(node.parentElement, [...acc, node]);
  return el === stop ? [] : up(el.parentElement, []);
};
