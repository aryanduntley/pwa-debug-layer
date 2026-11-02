import type { ChecksConfig, LayoutFinding } from '@pwa-debug/shared';
import type { MeasureContext } from './geometry.js';
import { accessibleName, elementFinding, elementSignature } from './element_info.js';
import { SIDES, axisOf, inkExtents, type InkExtent, type Side } from './paint.js';
import { clipsAxis } from './checks_box.js';

/**
 * Ancestors that can clip el: every overflow ancestor in normal flow; for an
 * absolutely positioned element only from its containing block (the nearest
 * positioned ancestor) outwards; nothing past a fixed element. html and body
 * hand their overflow to the viewport, so they are not clippers here.
 */
export const clippingAncestors = (ctx: MeasureContext, el: Element): readonly Element[] => {
  const walk = (node: Element | null, pos: string, acc: readonly Element[]): readonly Element[] => {
    if (node === null || node.tagName === 'BODY' || node.tagName === 'HTML' || pos === 'fixed') return acc;
    const nodePos = ctx.style(node, 'position');
    const containing = pos !== 'absolute' || nodePos !== 'static';
    const clips = containing && (clipsAxis(ctx, node, 'x') || clipsAxis(ctx, node, 'y'));
    return walk(node.parentElement, containing ? nodePos : pos, clips ? [...acc, node] : acc);
  };
  return walk(el.parentElement, ctx.style(el, 'position'), []);
};

type Cut = {
  readonly side: Side;
  readonly px: number;
  readonly ink: InkExtent;
  readonly clipper: Element;
};

/**
 * How much of the ink on one side the clipper hides for good: the part past
 * the edge of what it can scroll to (overflow: clip can't scroll at all).
 * Outlines and shadows don't add to scrollable overflow, so scrolling never
 * reveals them. Zero when the element's own box already crosses that edge
 * (then the box itself is clipped, which other checks see).
 */
const cutOnSide = (ctx: MeasureContext, el: Element, clipper: Element, side: Side, ink: InkExtent): number => {
  const axis = axisOf(side);
  if (!clipsAxis(ctx, clipper, axis)) return 0;
  const c = ctx.rect(clipper);
  const r = ctx.rect(el);
  const s = ctx.scroll(clipper);
  const scrolls = ctx.style(clipper, `overflow-${axis}`) !== 'clip';
  const start =
    axis === 'x'
      ? c.x + ctx.px(clipper, 'border-left-width') - (scrolls ? s.scrollLeft : 0)
      : c.y + ctx.px(clipper, 'border-top-width') - (scrolls ? s.scrollTop : 0);
  const padSize =
    axis === 'x'
      ? c.width - ctx.px(clipper, 'border-left-width') - ctx.px(clipper, 'border-right-width')
      : c.height - ctx.px(clipper, 'border-top-width') - ctx.px(clipper, 'border-bottom-width');
  const size = scrolls ? Math.max(padSize, axis === 'x' ? s.scrollWidth : s.scrollHeight) : padSize;
  const end = start + size;
  // An element spanning the clipper's whole visible extent on this axis
  // (a full-width panel or bar) has its shadow fall off the clipper's own
  // edges by design.
  const visStart = axis === 'x' ? c.x + ctx.px(clipper, 'border-left-width') : c.y + ctx.px(clipper, 'border-top-width');
  const lo = axis === 'x' ? r.x : r.y;
  const hi = axis === 'x' ? r.x + r.width : r.y + r.height;
  if (lo <= visStart + 1 && hi >= visStart + padSize - 1) return 0;
  const boxEdge =
    side === 'left' ? r.x : side === 'right' ? r.x + r.width : side === 'top' ? r.y : r.y + r.height;
  const beyond = side === 'left' || side === 'top' ? start - (boxEdge - ink.px) : boxEdge + ink.px - end;
  const boxInside = side === 'left' || side === 'top' ? boxEdge >= start - 0.5 : boxEdge <= end + 0.5;
  return boxInside ? Math.min(ink.px, Math.max(0, beyond)) : 0;
};

const overflowText = (ctx: MeasureContext, el: Element, side: Side): string => {
  const axis = axisOf(side);
  return `overflow-${axis}: ${ctx.style(el, `overflow-${axis}`)}`;
};

/**
 * ring_clipped: an outline or outer box-shadow (focus/selection rings, card
 * shadows) cut off by a scrolling or clipping ancestor. The ink sits outside
 * the border box, so box geometry alone never sees it. Reports the worst cut
 * per element, at least min_px whole CSS px.
 */
export const checkRingClipped = (
  ctx: MeasureContext,
  elements: readonly Element[],
  cfg: ChecksConfig['ring_clipped'],
): readonly LayoutFinding[] =>
  elements
    .filter((el) => el !== ctx.root && ctx.isVisible(el) && !ctx.isExempt(el) && !ctx.isAriaHidden(el))
    .flatMap((el) => {
      const ink = inkExtents(ctx, el);
      const sides = SIDES.filter((s) => ink[s].px >= cfg.min_px);
      if (sides.length === 0) return [];
      // Only the nearest clipper on an axis decides: a scroller in between moves
      // the element relative to anything further out.
      const clippers = clippingAncestors(ctx, el);
      const nearest = (axis: 'x' | 'y'): Element | undefined => clippers.find((c) => clipsAxis(ctx, c, axis));
      const cuts = sides.flatMap((side): readonly Cut[] => {
        const clipper = nearest(axisOf(side));
        return clipper === undefined
          ? []
          : [{ side, px: cutOnSide(ctx, el, clipper, side, ink[side]), ink: ink[side], clipper }];
      });
      const worst = [...cuts].sort((a, b) => b.px - a.px)[0];
      if (worst === undefined || Math.round(worst.px) < cfg.min_px) return [];
      return [
        elementFinding(
          ctx,
          'ring_clipped',
          el,
          `${worst.ink.source} of "${accessibleName(el)}" cut off ${Math.round(worst.px)}px of ${Math.round(worst.ink.px)}px on the ${worst.side} by ${elementSignature(worst.clipper).split(' ')[0]} (${overflowText(ctx, worst.clipper, worst.side)})`,
        ),
      ];
    });
