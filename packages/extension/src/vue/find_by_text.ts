/**
 * Locate Vue components by rendered text — parity with react/find_by_text, over
 * the Vue DOM-walk primitive. Matches elements whose trimmed textContent
 * satisfies a pre-compiled regex (exact = full-text match; otherwise substring),
 * maps each to its owning component, and returns root-scoped stable ids.
 *
 * pattern is a pre-compiled RegExp (the page-world handler owns compilation +
 * regex-error shaping) so this function is pure and never throws.
 */
import { walkVueDom } from './find.js';
import { computeStableId } from './compute_stable_id.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';

export type FindVueByTextOptions = {
  readonly rootIndex?: number;
  /** true = the regex must match the FULL trimmed text; false = substring match. */
  readonly exact?: boolean;
  readonly maxMatches?: number;
};

export type FindVueByTextMatch = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  /** The matched substring (or the full trimmed text when exact:true). */
  readonly matchedText: string;
};

export type FindVueByTextResult = {
  readonly matches: FindVueByTextMatch[];
  readonly truncated: boolean;
  readonly rootCount: number;
};

export const findVueByText = (
  doc: Document,
  pattern: RegExp,
  options: FindVueByTextOptions = {},
): FindVueByTextResult => {
  const exact = options.exact === true;
  const result = walkVueDom<string>(
    doc,
    (el) => {
      const text = (el.textContent ?? '').trim();
      if (text.length === 0) return null;
      const m = pattern.exec(text);
      if (m === null) return null;
      if (exact && m[0] !== text) return null;
      return exact ? text : m[0];
    },
    {
      ...(options.rootIndex !== undefined ? { rootIndex: options.rootIndex } : {}),
      ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
    },
  );

  const matches: FindVueByTextMatch[] = result.matches.map((mm) => {
    const key = extractKey(mm.instance);
    return Object.freeze({
      stableId: computeStableId(mm.instance, mm.rootIndex),
      displayName: extractDisplayName(mm.instance),
      ...(key !== undefined ? { key } : {}),
      matchedText: mm.extra,
    });
  });

  return Object.freeze({
    matches,
    truncated: result.truncated,
    rootCount: result.rootCount,
  });
};
