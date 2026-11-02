import type { ChecksConfig, LayoutFinding, LayoutRect } from '@pwa-debug/shared';
import { ancestorsWithin, memo1, type MeasureContext } from './geometry.js';
import { SIDES, axisOf, visibleEdges, type Side, type Sides } from './paint.js';
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

export const isOutOfFlow = (ctx: MeasureContext, el: Element): boolean => {
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

/** Overflow on one axis hides (or scrolls) content: anything but visible. */
export const clipsAxis = (ctx: MeasureContext, el: Element, axis: 'x' | 'y'): boolean =>
  ctx.style(el, `overflow-${axis}`) !== 'visible' && ctx.style(el, `overflow-${axis}`) !== '';

/**
 * Content of a box for one side: text-bearing elements and form controls,
 * not crossing into a nested element that shows its own edge on that side,
 * and not into a scroller or clipper on that side's axis (its content can be
 * scrolled or clipped away from where it sits).
 */
const sideLeaves = (
  ctx: MeasureContext,
  edges: (el: Element) => Sides<boolean>,
  parent: Element,
  side: Side,
): readonly Element[] =>
  [...parent.children].flatMap((child) => {
    if (!ctx.isVisible(child) || ctx.isExempt(child) || isOutOfFlow(ctx, child)) return [];
    if (isFormControl(child)) return [child];
    if (edges(child)[side]) return [];
    const own = hasOwnText(child) ? [child] : [];
    return clipsAxis(ctx, child, axisOf(side)) ? own : [...own, ...sideLeaves(ctx, edges, child, side)];
  });

/**
 * How a leaf is judged. `edged`: a control that shows its own edge (fails
 * only when it touches or crosses: two visible edges a few px apart, like a
 * segmented control's pill, read as a deliberate inset). `text`: text, and
 * controls with no edge of their own, measured by what they draw (fails on
 * left/right under min, or crossing any edge).
 */
type LeafKind = 'edged' | 'text';
type LeafShape = { readonly rect: LayoutRect; readonly kind: LeafKind; readonly padded: boolean };

const union = (rs: readonly LayoutRect[]): LayoutRect | null => {
  if (rs.length === 0) return null;
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rs.map((r) => r.x + r.width)) - x,
    height: Math.max(...rs.map((r) => r.y + r.height)) - y,
  };
};

const DRAWN_MEDIA = new Set(['svg', 'img', 'canvas', 'video', 'picture']);

/** What an edge-less control draws: its text line boxes and icons/images, itself included. */
const controlInk = (ctx: MeasureContext, control: Element): LayoutRect | null =>
  union(
    [control, ...control.querySelectorAll('*')]
      .filter((el) => el === control || ctx.isVisible(el))
      .flatMap((el) => {
        if (DRAWN_MEDIA.has(el.tagName.toLowerCase())) return [ctx.rect(el)];
        const ink = ctx.textInk(el);
        return ink !== null ? [ink] : [];
      }),
  );

const TEXT_ENTRY = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * The part of a leaf that can touch an edge. Text: its line boxes (else its
 * rect inside its padding). A control showing an edge: its border box. A
 * control with no edge: what it draws, or for a text field its padding box;
 * null when it draws nothing measurable.
 */
const leafShape = (ctx: MeasureContext, edges: (el: Element) => Sides<boolean>, leaf: Element): LeafShape | null => {
  if (isFormControl(leaf)) {
    if (SIDES.some((s) => edges(leaf)[s])) return { rect: ctx.rect(leaf), kind: 'edged', padded: false };
    const ink = controlInk(ctx, leaf);
    if (ink !== null) return { rect: ink, kind: 'text', padded: false };
    return TEXT_ENTRY.test(leaf.tagName) ? { rect: ctx.rect(leaf), kind: 'text', padded: true } : null;
  }
  const ink = ctx.textInk(leaf);
  return ink !== null ? { rect: ink, kind: 'text', padded: false } : { rect: ctx.rect(leaf), kind: 'text', padded: true };
};

type Inset = { readonly side: Side; readonly px: number; readonly leaf: Element; readonly kind: LeafKind };

const innerEdges = (ctx: MeasureContext, box: Element) => {
  const b = ctx.rect(box);
  return {
    left: b.x + ctx.px(box, 'border-left-width'),
    right: b.x + b.width - ctx.px(box, 'border-right-width'),
    top: b.y + ctx.px(box, 'border-top-width'),
    bottom: b.y + b.height - ctx.px(box, 'border-bottom-width'),
  };
};

/** Distance from the leaf's shape to the box's inner edge on one side. */
const sideInset = (ctx: MeasureContext, box: Element, leaf: Element, shape: LeafShape, side: Side): Inset => {
  const inner = innerEdges(ctx, box);
  const r = shape.rect;
  const pad = shape.padded ? ctx.px(leaf, `padding-${side}`) : 0;
  const px =
    side === 'left'
      ? r.x + pad - inner.left
      : side === 'right'
        ? inner.right - (r.x + r.width - pad)
        : side === 'top'
          ? r.y + pad - inner.top
          : inner.bottom - (r.y + r.height - pad);
  return { side, px, leaf, kind: shape.kind };
};

/**
 * A control that shows its edge and spans the box's full inner width is
 * full-bleed by design (a banner button, a card's footer action), not
 * content missing its padding.
 */
const fullBleed = (ctx: MeasureContext, box: Element, shape: LeafShape): boolean => {
  if (shape.kind !== 'edged') return false;
  const inner = innerEdges(ctx, box);
  return shape.rect.x <= inner.left + 0.5 && shape.rect.x + shape.rect.width >= inner.right - 0.5;
};

/**
 * Compared in whole CSS px, as reported, so sub-pixel layout never yields
 * "4px (min 4)". Text: left/right under min, or crossing any edge. Edged
 * controls: touching or crossing.
 */
const violates = (i: Inset, min: number): boolean => {
  const px = Math.round(i.px);
  if (px < 0) return true;
  return i.kind === 'edged' ? px < 1 : axisOf(i.side) === 'x' && px < min;
};

/**
 * edge_contact: inside a box with a visible edge, text or a control touching
 * or crossing that edge (padding a parent rule zeroed). Text and edge-less
 * controls are measured by what they draw; controls with their own edge
 * fail only when touching, and full-width ones are skipped. Each side is measured
 * against the nearest box that shows an edge there, so a divider-only or
 * same-color row inside a padded card is judged by the card. One finding per
 * box, naming the worst side.
 */
export const checkEdgeContact = (
  ctx: MeasureContext,
  elements: readonly Element[],
  cfg: ChecksConfig['edge_contact'],
): readonly LayoutFinding[] => {
  const edges = memo1((el: Element) => visibleEdges(ctx, el));
  return elements
    .filter(
      (el) =>
        el !== ctx.root &&
        el.tagName !== 'HTML' &&
        el.tagName !== 'BODY' &&
        ctx.isVisible(el) &&
        !ctx.isExempt(el) &&
        !ctx.isAriaHidden(el) &&
        SIDES.some((s) => edges(el)[s]),
    )
    .flatMap((box) => {
      const shape = memo1((leaf: Element) => leafShape(ctx, edges, leaf));
      const bad = SIDES.filter((s) => edges(box)[s] && !clipsAxis(ctx, box, axisOf(s)))
        .flatMap((s) =>
          sideLeaves(ctx, edges, box, s).flatMap((leaf) => {
            const sh = shape(leaf);
            return sh === null || fullBleed(ctx, box, sh) ? [] : [sideInset(ctx, box, leaf, sh, s)];
          }),
        )
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
};
