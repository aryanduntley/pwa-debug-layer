/**
 * Svelte DOM-walk primitive shared by svelte.findByText / findByRole. Like the
 * Vue walker it walks the rendered DOM and maps each accepted element to its
 * owning unit — but for Svelte that unit is the component SOURCE FILE
 * (componentFileForNode), since Svelte has no instance objects. Matches are
 * de-duped by file (one entry per component file). Svelte has no clean mount-
 * root marker, so the whole document is walked.
 *
 * Pure: DOM reads only, never throws.
 */
import { componentFileForNode } from './meta.js';

const DEFAULT_MAX_MATCHES = 20;

export type SvelteDomMatch<E> = {
  readonly file: string;
  readonly extra: E;
};

export type WalkSvelteDomOptions = {
  readonly maxMatches?: number;
};

export type WalkSvelteDomResult<E> = {
  readonly matches: SvelteDomMatch<E>[];
  readonly truncated: boolean;
};

export const walkSvelteDom = <E>(
  doc: Document,
  predicate: (el: Element) => E | null,
  options: WalkSvelteDomOptions = {},
): WalkSvelteDomResult<E> => {
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const matches: SvelteDomMatch<E>[] = [];
  const seen = new Set<string>();
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
    const file = componentFileForNode(el);
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    matches.push({ file, extra });
  }

  return { matches, truncated };
};
