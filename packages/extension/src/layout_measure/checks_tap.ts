import type { ChecksConfig, LayoutFinding } from '@pwa-debug/shared';
import type { MeasureContext } from './geometry.js';
import { accessibleName, elementFinding, INTERACTIVE_SELECTOR, sizeText } from './element_info.js';

const CONTROL_IN_LABEL = 'input,select,textarea';

/** A label counts as a target only when it wraps a control (it is then the hit area). */
const isTargetCandidate = (el: Element): boolean =>
  el.matches(INTERACTIVE_SELECTOR) &&
  (el.tagName !== 'LABEL' || el.querySelector(CONTROL_IN_LABEL) !== null);

/** Controls inside a label are measured by the label; targets nested in targets by the outer one. */
const coveredByOuterTarget = (el: Element): boolean => {
  if (el.tagName !== 'LABEL' && el.closest('label') !== null) return true;
  const outer = el.parentElement?.closest(INTERACTIVE_SELECTOR) ?? null;
  return outer !== null && isTargetCandidate(outer);
};

/** WCAG 2.5.8 inline exception: a link inside a sentence, not alone in its block. */
const isInlineSentenceLink = (ctx: MeasureContext, el: Element): boolean => {
  if (el.tagName !== 'A' || ctx.style(el, 'display') !== 'inline') return false;
  const own = (el.textContent ?? '').trim().length;
  const block = (el.parentElement?.textContent ?? '').trim().length;
  return block > own;
};

/**
 * tap_target: interactive elements smaller than `min` CSS px in either
 * dimension, except inline sentence links and controls measured by their label.
 */
export const checkTapTargets = (
  ctx: MeasureContext,
  elements: readonly Element[],
  cfg: ChecksConfig['tap_target'],
): readonly LayoutFinding[] =>
  elements
    .filter(
      (el) =>
        isTargetCandidate(el) &&
        ctx.isVisible(el) &&
        !ctx.isExempt(el) &&
        !ctx.isAriaHidden(el) &&
        !coveredByOuterTarget(el) &&
        !isInlineSentenceLink(ctx, el),
    )
    .flatMap((el) => {
      const r = ctx.rect(el);
      if (r.width >= cfg.min && r.height >= cfg.min) return [];
      return [
        elementFinding(
          ctx,
          'tap_target',
          el,
          `tap target ${sizeText(r.width, r.height)} "${accessibleName(el)}" (min ${cfg.min})`,
        ),
      ];
    });
