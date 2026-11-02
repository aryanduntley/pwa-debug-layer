import type { ChecksConfig, LayoutFinding, LayoutRect } from '@pwa-debug/shared';
import { ancestorsWithin, type MeasureContext } from './geometry.js';
import { accessibleName, elementFinding, hasOwnText, isFormControl } from './element_info.js';

const SLACK = 1;

/** page_overflow_x: the document is wider than the layout viewport. */
export const checkPageOverflow = (
  ctx: MeasureContext,
  docScrollWidth: number,
): readonly LayoutFinding[] =>
  docScrollWidth > ctx.viewport.width + SLACK
    ? [
        {
          check: 'page_overflow_x',
          signature: 'html',
          message: `page scrolls sideways: content is ${Math.round(docScrollWidth)}px wide in a ${ctx.viewport.width}px viewport`,
        },
      ]
    : [];

const isScrollerX = (ctx: MeasureContext, el: Element): boolean => {
  const ox = ctx.style(el, 'overflow-x');
  if (ox === 'hidden' || ox === 'clip') return true;
  if (ox !== 'auto' && ox !== 'scroll') return false;
  const s = ctx.scroll(el);
  return s.scrollWidth > s.clientWidth;
};

/** True when an ancestor inside the root scrolls or clips horizontally (carousels, chip rows). */
const insideHorizontalClip = (ctx: MeasureContext, el: Element): boolean =>
  ancestorsWithin(el, ctx.root).some((a) => a !== ctx.root && isScrollerX(ctx, a));

const crossesX = (ctx: MeasureContext, r: LayoutRect): boolean =>
  r.x < -SLACK || r.x + r.width > ctx.viewport.width + SLACK;

const fullyOutsideX = (ctx: MeasureContext, r: LayoutRect): boolean =>
  r.x + r.width <= 0 || r.x >= ctx.viewport.width;

const isOutOfFlow = (ctx: MeasureContext, el: Element): boolean => {
  const p = ctx.style(el, 'position');
  return p === 'fixed' || p === 'absolute';
};

const offending = (ctx: MeasureContext, el: Element): boolean => {
  if (!ctx.isVisible(el) || ctx.isExempt(el) || ctx.isAriaHidden(el)) return false;
  const r = ctx.rect(el);
  if (!crossesX(ctx, r)) return false;
  // Off-canvas drawers parked fully outside the viewport are hidden UI, not overflow.
  if (fullyOutsideX(ctx, r) && isOutOfFlow(ctx, el)) return false;
  return !insideHorizontalClip(ctx, el);
};

/**
 * offscreen: visible elements extending past the left or right viewport edge.
 * Only the outermost offender is reported (its descendants overflow with it),
 * and anything inside a horizontally scrolling or clipping ancestor is skipped.
 */
export const checkOffscreen = (
  ctx: MeasureContext,
  elements: readonly Element[],
): readonly LayoutFinding[] => {
  const hits = new Set(elements.filter((el) => offending(ctx, el)));
  return [...hits]
    .filter((el) => !ancestorsWithin(el, ctx.root).some((a) => hits.has(a)))
    .map((el) => {
      const r = ctx.rect(el);
      const side = r.x < -SLACK ? `${Math.round(-r.x)}px past the left edge` : `${Math.round(r.x + r.width - ctx.viewport.width)}px past the right edge`;
      return elementFinding(ctx, 'offscreen', el, `off screen: ${side} of a ${ctx.viewport.width}px viewport`);
    });
};

const matchesAny = (el: Element, selectors: readonly string[]): boolean =>
  selectors.some((s) => el.matches(s));

const containedInViewport = (ctx: MeasureContext, r: LayoutRect): boolean =>
  r.x >= -SLACK &&
  r.y >= -SLACK &&
  r.x + r.width <= ctx.viewport.width + SLACK &&
  r.y + r.height <= ctx.viewport.height + SLACK;

const intersectsViewport = (ctx: MeasureContext, r: LayoutRect): boolean =>
  r.x < ctx.viewport.width && r.x + r.width > 0 && r.y < ctx.viewport.height && r.y + r.height > 0;

const edgeText = (ctx: MeasureContext, r: LayoutRect): string => {
  const below = r.y + r.height - ctx.viewport.height;
  if (below > SLACK) return `${Math.round(below)}px below the bottom edge`;
  if (r.y < -SLACK) return `${Math.round(-r.y)}px above the top edge`;
  if (r.x < -SLACK) return `${Math.round(-r.x)}px past the left edge`;
  return `${Math.round(r.x + r.width - ctx.viewport.width)}px past the right edge`;
};

/**
 * pinned_visible: position:fixed elements (and any pinned_selectors match) must
 * sit fully inside the viewport. A fixed element entirely outside it is taken
 * as parked hidden UI (a closed sheet) unless a pinned selector names it.
 */
export const checkPinnedVisible = (
  ctx: MeasureContext,
  elements: readonly Element[],
  cfg: ChecksConfig['pinned_visible'],
): readonly LayoutFinding[] =>
  elements
    .filter((el) => ctx.isVisible(el) && !ctx.isExempt(el) && !ctx.isAriaHidden(el))
    .flatMap((el) => {
      const named = matchesAny(el, cfg.pinned_selectors);
      if (!named && ctx.style(el, 'position') !== 'fixed') return [];
      const r = ctx.rect(el);
      if (containedInViewport(ctx, r)) return [];
      if (!named && !intersectsViewport(ctx, r)) return [];
      return [elementFinding(ctx, 'pinned_visible', el, `pinned element not fully on screen: ${edgeText(ctx, r)}`)];
    });

const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|rgb\(\s*0\s+0\s+0\s*\/\s*0\s*\))$/;

const hasBorder = (ctx: MeasureContext, el: Element): boolean =>
  (['top', 'right', 'bottom', 'left'] as const).some(
    (s) => ctx.px(el, `border-${s}-width`) > 0 && !/^(none|hidden|)$/.test(ctx.style(el, `border-${s}-style`)),
  );

/** A visible box of its own: border, background or shadow (a card, a field, a sheet). */
export const isBoxed = (ctx: MeasureContext, el: Element): boolean => {
  const bg = ctx.style(el, 'background-color');
  const img = ctx.style(el, 'background-image');
  const shadow = ctx.style(el, 'box-shadow');
  return (
    hasBorder(ctx, el) ||
    (bg !== '' && !TRANSPARENT.test(bg)) ||
    (img !== '' && img !== 'none') ||
    (shadow !== '' && shadow !== 'none')
  );
};

/** Content of a box: text-bearing elements and form controls, not crossing into nested boxes. */
const contentLeaves = (ctx: MeasureContext, box: Element): readonly Element[] =>
  [...box.children].flatMap((child) => {
    if (!ctx.isVisible(child) || ctx.isExempt(child) || isOutOfFlow(ctx, child)) return [];
    if (isFormControl(child)) return [child];
    if (isBoxed(ctx, child)) return [];
    return [...(hasOwnText(child) ? [child] : []), ...contentLeaves(ctx, child)];
  });

type Inset = { readonly side: string; readonly px: number; readonly leaf: Element };

const leafInsets = (ctx: MeasureContext, box: Element, leaf: Element): readonly Inset[] => {
  const b = ctx.rect(box);
  const inner = {
    l: b.x + ctx.px(box, 'border-left-width'),
    r: b.x + b.width - ctx.px(box, 'border-right-width'),
    t: b.y + ctx.px(box, 'border-top-width'),
    b: b.y + b.height - ctx.px(box, 'border-bottom-width'),
  };
  const control = isFormControl(leaf);
  const lr = ctx.rect(leaf);
  // Text sits inside the leaf's own padding; a control's edge is its border box.
  const pad = (s: string): number => (control ? 0 : ctx.px(leaf, `padding-${s}`));
  const clipsX = ctx.style(box, 'overflow-x') !== 'visible';
  const clipsY = ctx.style(box, 'overflow-y') !== 'visible';
  const horizontal: readonly Inset[] = clipsX
    ? []
    : [
        { side: 'left', px: lr.x + pad('left') - inner.l, leaf },
        { side: 'right', px: inner.r - (lr.x + lr.width - pad('right')), leaf },
      ];
  const vertical: readonly Inset[] = clipsY
    ? []
    : [
        { side: 'top', px: lr.y + pad('top') - inner.t, leaf },
        { side: 'bottom', px: inner.b - (lr.y + lr.height - pad('bottom')), leaf },
      ];
  return [...horizontal, ...vertical];
};

/** Text: left/right closer than min, or crossing any edge. Controls: any side closer than min. */
const violates = (i: Inset, min: number): boolean =>
  i.px < 0 || ((i.side === 'left' || i.side === 'right' || isFormControl(i.leaf)) && i.px < min);

/**
 * edge_contact: inside a visible box, text or a control touching or crossing
 * the box's inner edge (padding a parent rule zeroed). One finding per box,
 * naming the worst side.
 */
export const checkEdgeContact = (
  ctx: MeasureContext,
  elements: readonly Element[],
  cfg: ChecksConfig['edge_contact'],
): readonly LayoutFinding[] =>
  elements
    .filter(
      (el) =>
        el !== ctx.root &&
        el.tagName !== 'HTML' &&
        el.tagName !== 'BODY' &&
        ctx.isVisible(el) &&
        !ctx.isExempt(el) &&
        !ctx.isAriaHidden(el) &&
        isBoxed(ctx, el),
    )
    .flatMap((box) => {
      const bad = contentLeaves(ctx, box)
        .flatMap((leaf) => leafInsets(ctx, box, leaf))
        .filter((i) => violates(i, cfg.min_inset))
        .sort((a, b) => a.px - b.px);
      const worst = bad[0];
      if (worst === undefined) return [];
      const what = isFormControl(worst.leaf) ? 'control' : 'text';
      return [
        elementFinding(
          ctx,
          'edge_contact',
          box,
          `${what} "${accessibleName(worst.leaf)}" is ${Math.round(worst.px)}px from the ${worst.side} edge of its box (min ${cfg.min_inset})`,
        ),
      ];
    });
