/** Element description helpers shared by the layout checks. Read-only. */
import type { LayoutCheckName, LayoutFinding } from '@pwa-debug/shared';
import type { MeasureContext } from './geometry.js';

const collapse = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const NAME_MAX = 40;

/**
 * Short accessible name: aria-label, aria-labelledby text, alt, title,
 * placeholder, a button-type input's value, then the text content.
 */
export const accessibleName = (el: Element): string => {
  const attr = (n: string): string => (el.getAttribute(n) ?? '').trim();
  const labelledBy = attr('aria-labelledby')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ');
  const inputValue =
    el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(attr('type')) ? attr('value') : '';
  const candidates = [
    attr('aria-label'),
    labelledBy,
    attr('alt'),
    attr('title'),
    attr('placeholder'),
    inputValue,
    el.textContent ?? '',
  ];
  return collapse(candidates.find((c) => c.trim().length > 0) ?? '', NAME_MAX);
};

const CLASS_MAX = 3;
const CLASS_LEN_MAX = 30;

/**
 * Stable-ish element signature for grouping: tag#id.class1.class2.class3 "name".
 * Long (hashed / utility-soup) class names are skipped; numbers are stripped
 * later by the grouper, not here, so messages keep real values.
 */
export const elementSignature = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  const id = el.id !== '' ? `#${el.id}` : '';
  const classes = [...el.classList]
    .filter((c) => c.length <= CLASS_LEN_MAX)
    .slice(0, CLASS_MAX)
    .map((c) => `.${c}`)
    .join('');
  const name = accessibleName(el);
  return `${tag}${id}${classes}${name !== '' ? ` "${name}"` : ''}`;
};

/** True when el has a direct, non-whitespace text node child. */
export const hasOwnText = (el: Element): boolean =>
  [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);

export const INTERACTIVE_SELECTOR =
  'a[href],button,[role="button"],input:not([type="hidden"]),select,textarea,summary,label';

export const FORM_CONTROL_SELECTOR = 'input:not([type="hidden"]),select,textarea,button';

export const isFormControl = (el: Element): boolean => el.matches(FORM_CONTROL_SELECTOR);

/** Rounded "w×h" for messages. */
export const sizeText = (w: number, h: number): string => `${Math.round(w)}×${Math.round(h)}`;

const roundRect = (r: { x: number; y: number; width: number; height: number }) => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.round(r.width),
  height: Math.round(r.height),
});

/** A finding about one element: its signature, the message, its rounded rect. */
export const elementFinding = (
  ctx: MeasureContext,
  check: LayoutCheckName,
  el: Element,
  message: string,
): LayoutFinding => ({
  check,
  signature: elementSignature(el),
  message,
  rect: roundRect(ctx.rect(el)),
});
