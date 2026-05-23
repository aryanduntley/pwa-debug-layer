/**
 * Solid DOM-walk primitive + element locator. Because Solid exposes no
 * component identity, matches are ELEMENT-level (not component-level): each
 * match carries a CSS-ish locator and tag so the caller can find the node
 * again. Pure DOM reads; never throws.
 */

const DEFAULT_MAX_MATCHES = 20;

export type SolidDomMatch<E> = {
  readonly locator: string;
  readonly tag: string;
  readonly extra: E;
};

export type WalkSolidDomOptions = {
  readonly maxMatches?: number;
};

export type WalkSolidDomResult<E> = {
  readonly matches: SolidDomMatch<E>[];
  readonly truncated: boolean;
};

/**
 * A short CSS-ish locator for an element: `tag#id` when it has an id, otherwise
 * `tag.firstClass` plus an `:nth-of-type(n)` index when it has same-tag
 * siblings. Best-effort hint, not a guaranteed-unique selector.
 */
export const elementLocator = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  if (el.id.length > 0) return `${tag}#${el.id}`;
  let sel = tag;
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
  if (cls !== undefined && cls.length > 0) sel += `.${cls}`;
  const parent = el.parentElement;
  if (parent !== null) {
    const sameTag = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName,
    );
    if (sameTag.length > 1) {
      sel += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
  }
  return sel;
};

export const walkSolidDom = <E>(
  doc: Document,
  predicate: (el: Element) => E | null,
  options: WalkSolidDomOptions = {},
): WalkSolidDomResult<E> => {
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const matches: SolidDomMatch<E>[] = [];
  let truncated = false;

  let all: ArrayLike<Element>;
  try {
    all = doc.querySelectorAll('*');
  } catch {
    return { matches, truncated };
  }

  for (let i = 0; i < all.length; i++) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    const el = all[i];
    if (el === undefined) continue;
    const extra = predicate(el);
    if (extra === null) continue;
    matches.push({ locator: elementLocator(el), tag: el.tagName.toLowerCase(), extra });
  }

  return { matches, truncated };
};
