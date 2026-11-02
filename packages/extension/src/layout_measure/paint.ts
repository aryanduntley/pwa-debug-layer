/**
 * What an element paints, as far as layout checks care: the background
 * behind it, which of its edges a viewer can actually see, and how far its
 * outline and outer shadows reach past its border box. Read-only.
 */
import type { MeasureContext } from './geometry.js';
import { blendOver, parseCssColor, type Rgba } from './color.js';

export type Side = 'top' | 'right' | 'bottom' | 'left';
/** Reading order: on a tie the left/right finding is the one reported. */
export const SIDES: readonly Side[] = Object.freeze(['left', 'right', 'top', 'bottom']);
export type Sides<T> = { readonly [S in Side]: T };

export const axisOf = (side: Side): 'x' | 'y' => (side === 'left' || side === 'right' ? 'x' : 'y');

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * Effective background behind el: background colors from el outwards,
 * composited until opaque (white canvas at the top). Null when an ancestor
 * paints a background image or a color this parser can't read.
 */
export const effectiveBackground = (ctx: MeasureContext, el: Element | null): Rgba | null => {
  const layers = (node: Element | null, acc: readonly Rgba[]): readonly Rgba[] | null => {
    if (node === null) return acc;
    const img = ctx.style(node, 'background-image');
    if (img !== '' && img !== 'none') return null;
    const raw = ctx.style(node, 'background-color');
    const c = raw === '' ? { r: 0, g: 0, b: 0, a: 0 } : parseCssColor(raw);
    if (c === null) return null;
    const next = c.a > 0 ? [...acc, c] : acc;
    return c.a >= 1 ? next : layers(node.parentElement, next);
  };
  const stack = layers(el, []);
  if (stack === null) return null;
  return [...stack].reverse().reduce<Rgba>((under, top) => blendOver(top, under), WHITE);
};

/** A color a viewer can see: unparseable colors count as visible, alpha 0 does not. */
const colorShows = (raw: string): boolean => {
  if (raw === '') return true;
  const c = parseCssColor(raw);
  return c === null || c.a > 0;
};

/** Smallest per-channel difference (0..255) that reads as a separate surface. */
const SURFACE_DELTA = 3;

/**
 * True when el's background color stands out from what is behind it. Unknown
 * colors or an image behind count as standing out (can't prove otherwise).
 */
const backgroundStandsOut = (ctx: MeasureContext, el: Element): boolean => {
  const raw = ctx.style(el, 'background-color');
  if (raw === '') return false;
  const bg = parseCssColor(raw);
  if (bg === null) return true;
  if (bg.a === 0) return false;
  const under = effectiveBackground(ctx, el.parentElement);
  if (under === null) return true;
  const seen = blendOver(bg, under);
  return Math.max(Math.abs(seen.r - under.r), Math.abs(seen.g - under.g), Math.abs(seen.b - under.b)) > SURFACE_DELTA;
};

export type Shadow = {
  readonly inset: boolean;
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly spread: number;
  readonly visible: boolean;
};

/** Split on commas outside parentheses (colors carry their own commas). */
const splitTopLevel = (s: string): readonly string[] => {
  type Scan = { readonly parts: readonly string[]; readonly cur: string; readonly depth: number };
  const end = [...s].reduce<Scan>(
    (st, ch) =>
      ch === ',' && st.depth === 0
        ? { parts: [...st.parts, st.cur], cur: '', depth: 0 }
        : {
            parts: st.parts,
            cur: st.cur + ch,
            depth: ch === '(' ? st.depth + 1 : ch === ')' ? Math.max(0, st.depth - 1) : st.depth,
          },
    { parts: [], cur: '', depth: 0 },
  );
  return [...end.parts, end.cur].map((p) => p.trim()).filter(Boolean);
};

const COLOR_TOKEN = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b|\bcurrentcolor\b/i;

/** Parse a computed box-shadow list. `none` and unparseable layers give []. */
export const parseBoxShadows = (value: string): readonly Shadow[] => {
  if (value === '' || value === 'none') return [];
  return splitTopLevel(value).flatMap((layer) => {
    const color = COLOR_TOKEN.exec(layer)?.[0] ?? '';
    const rest = layer.replace(color, ' ').replace(/\binset\b/i, ' ');
    const lengths = (rest.match(/-?\d*\.?\d+(?:px)?/g) ?? []).map(parseFloat);
    if (lengths.length < 2 || !lengths.every(Number.isFinite)) return [];
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    return [{ inset: /\binset\b/i.test(layer), x, y, blur, spread, visible: colorShows(color) }];
  });
};

const hasShadow = (ctx: MeasureContext, el: Element): boolean =>
  parseBoxShadows(ctx.style(el, 'box-shadow')).some((s) => s.visible);

const borderShows = (ctx: MeasureContext, el: Element, side: Side): boolean =>
  ctx.px(el, `border-${side}-width`) > 0 &&
  !/^(none|hidden|)$/.test(ctx.style(el, `border-${side}-style`)) &&
  colorShows(ctx.style(el, `border-${side}-color`));

/**
 * Which edges of el a viewer can see: a border on that side, or (all sides) a
 * visible shadow, a background image, or a background color that differs
 * from the surface behind it. A same-color row or a divider-only row has no
 * visible left/right edge, so its content's room comes from an outer box.
 */
export const visibleEdges = (ctx: MeasureContext, el: Element): Sides<boolean> => {
  const img = ctx.style(el, 'background-image');
  const whole = (img !== '' && img !== 'none') || hasShadow(ctx, el) || backgroundStandsOut(ctx, el);
  return {
    top: whole || borderShows(ctx, el, 'top'),
    right: whole || borderShows(ctx, el, 'right'),
    bottom: whole || borderShows(ctx, el, 'bottom'),
    left: whole || borderShows(ctx, el, 'left'),
  };
};

export type InkExtent = { readonly px: number; readonly source: 'outline' | 'box-shadow' };

const NO_INK: InkExtent = { px: 0, source: 'box-shadow' };

const larger = (a: InkExtent, b: InkExtent): InkExtent => (b.px > a.px ? b : a);

/**
 * How far el's outline and outer (non-inset, visible) shadows reach past its
 * border box on each side. A blur counts for half its radius (where the
 * shadow is still clearly visible); offsets push one side out and pull the
 * other in.
 */
export const inkExtents = (ctx: MeasureContext, el: Element): Sides<InkExtent> => {
  const os = ctx.style(el, 'outline-style');
  const outlinePx =
    os !== '' && os !== 'none' && colorShows(ctx.style(el, 'outline-color'))
      ? Math.max(0, ctx.px(el, 'outline-width') + ctx.px(el, 'outline-offset'))
      : 0;
  const outline: InkExtent = { px: outlinePx, source: 'outline' };
  const shadows = parseBoxShadows(ctx.style(el, 'box-shadow')).filter((s) => !s.inset && s.visible);
  const reach = (pick: (s: Shadow) => number): InkExtent =>
    shadows.reduce<InkExtent>(
      (best, s) => larger(best, { px: Math.max(0, s.spread + s.blur / 2 + pick(s)), source: 'box-shadow' }),
      NO_INK,
    );
  return {
    top: larger(outline, reach((s) => -s.y)),
    right: larger(outline, reach((s) => s.x)),
    bottom: larger(outline, reach((s) => s.y)),
    left: larger(outline, reach((s) => -s.x)),
  };
};
