import { DEFAULT_TEXT_PATTERNS, type ChecksConfig, type LayoutFinding } from '@pwa-debug/shared';
import type { MeasureContext } from './geometry.js';
import { accessibleName, elementFinding, hasOwnText } from './element_info.js';
import { blendOver, contrastRatio, parseCssColor, type Rgba } from './color.js';

const SLACK = 1;

const clipsText = (ctx: MeasureContext, el: Element): boolean => {
  if (ctx.style(el, 'text-overflow') === 'ellipsis') return true;
  const ox = ctx.style(el, 'overflow-x');
  return (ox === 'hidden' || ox === 'clip') && hasOwnText(el);
};

/**
 * text_clipped: an element that hides horizontal overflow (or ellipsizes)
 * and holds text needing more width than it has, e.g. a button label cut
 * off in a longer language.
 */
export const checkTextClipped = (
  ctx: MeasureContext,
  elements: readonly Element[],
): readonly LayoutFinding[] =>
  elements
    .filter(
      (el) =>
        ctx.isVisible(el) &&
        !ctx.isExempt(el) &&
        !ctx.isAriaHidden(el) &&
        (el.textContent ?? '').trim().length > 0 &&
        clipsText(ctx, el),
    )
    .flatMap((el) => {
      const s = ctx.scroll(el);
      if (s.scrollWidth <= s.clientWidth + SLACK) return [];
      return [
        elementFinding(
          ctx,
          'text_clipped',
          el,
          `text cut off: "${accessibleName(el)}" needs ${Math.round(s.scrollWidth)}px, has ${Math.round(s.clientWidth)}px`,
        ),
      ];
    });

const MATCHES_PER_PATTERN = 5;

const distinctMatches = (text: string, source: string): readonly string[] => {
  const re = new RegExp(source, 'g');
  return [...new Set([...text.matchAll(re)].map((m) => m[0]).filter((m) => m.length > 0))].slice(
    0,
    MATCHES_PER_PATTERN,
  );
};

/** Rendered text of the root: innerText where the engine has it, textContent otherwise. */
export const renderedText = (root: Element): string => {
  const inner = (root as HTMLElement).innerText;
  return typeof inner === 'string' ? inner : (root.textContent ?? '');
};

/**
 * text_patterns: unresolved copy in the root's rendered text (template
 * placeholders, undefined, NaN, [object Object], plus the caller's extra
 * patterns such as raw i18n keys). One finding per distinct match.
 */
export const checkTextPatterns = (
  text: string,
  cfg: ChecksConfig['text_patterns'],
): readonly LayoutFinding[] =>
  [...DEFAULT_TEXT_PATTERNS, ...cfg.extra].flatMap((source) =>
    distinctMatches(text, source).map((match) => ({
      check: 'text_patterns' as const,
      signature: `text "${match}"`,
      message: `unresolved text ${JSON.stringify(match)} (pattern /${source}/)`,
    })),
  );

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * Effective background behind el: background colors from el outwards,
 * composited until opaque (white canvas at the top). Null when an ancestor
 * paints a background image or a color this parser can't read.
 */
export const effectiveBackground = (ctx: MeasureContext, el: Element): Rgba | null => {
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

const isLargeText = (ctx: MeasureContext, el: Element): boolean => {
  const size = ctx.px(el, 'font-size');
  const weight = parseInt(ctx.style(el, 'font-weight'), 10);
  return size >= 24 || (size >= 18.66 && Number.isFinite(weight) && weight >= 700);
};

/**
 * contrast (off by default): text color against the effective background,
 * WCAG AA 4.5:1, 3:1 for large text. Approximate: skipped under background
 * images and for colors the parser can't read.
 */
export const checkContrast = (
  ctx: MeasureContext,
  elements: readonly Element[],
): readonly LayoutFinding[] =>
  elements
    .filter((el) => hasOwnText(el) && ctx.isVisible(el) && !ctx.isExempt(el) && !ctx.isAriaHidden(el))
    .flatMap((el) => {
      const fg = parseCssColor(ctx.style(el, 'color'));
      const bg = effectiveBackground(ctx, el);
      if (fg === null || bg === null) return [];
      const ratio = contrastRatio(blendOver(fg, bg), bg);
      const need = isLargeText(ctx, el) ? 3 : 4.5;
      if (ratio >= need) return [];
      return [
        elementFinding(
          ctx,
          'contrast',
          el,
          `contrast ${ratio.toFixed(2)}:1 "${accessibleName(el)}" (needs ${need}:1; approximate)`,
        ),
      ];
    });
