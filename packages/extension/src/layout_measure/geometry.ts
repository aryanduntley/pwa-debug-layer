import type { LayoutRect } from '@pwa-debug/shared';

/**
 * The DOM reads the layout checks need, injectable so tests can supply rects
 * (happy-dom has no layout engine). domGeometry is the real implementation.
 */
export type LayoutGeometry = {
  readonly rectOf: (el: Element) => LayoutRect;
  readonly styleOf: (el: Element, prop: string) => string;
  readonly scrollOf: (el: Element) => { readonly scrollWidth: number; readonly clientWidth: number };
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
  scrollOf: (el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }),
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

/** Memoized reads plus the per-measure predicates every check shares. */
export type MeasureContext = {
  readonly root: Element;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly rect: (el: Element) => LayoutRect;
  readonly style: (el: Element, prop: string) => string;
  readonly scroll: (el: Element) => { readonly scrollWidth: number; readonly clientWidth: number };
  readonly px: (el: Element, prop: string) => number;
  readonly isVisible: (el: Element) => boolean;
  readonly isExempt: (el: Element) => boolean;
  readonly isAriaHidden: (el: Element) => boolean;
};

const memo1 = <K extends object, V>(fn: (k: K) => V): ((k: K) => V) => {
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
  const px = (el: Element, prop: string): number => {
    const n = parseFloat(style(el, prop));
    return Number.isFinite(n) ? n : 0;
  };
  const isVisible = memo1((el: Element): boolean => {
    const r = rect(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      style(el, 'display') !== 'none' &&
      style(el, 'visibility') !== 'hidden' &&
      style(el, 'opacity') !== '0'
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
