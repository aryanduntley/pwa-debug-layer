/**
 * Locate elements by rendered text on a Solid page. ELEMENT-level (Solid has no
 * component identity — see Path 5 research note): returns each matching node's
 * locator + tag + matched text. pattern is a pre-compiled RegExp; pure.
 */
import { walkSolidDom } from './find.js';
import type { SolidTextMatch } from './types.js';

export type FindSolidByTextOptions = {
  readonly exact?: boolean;
  readonly maxMatches?: number;
};

export type FindSolidByTextResult = {
  readonly matches: SolidTextMatch[];
  readonly truncated: boolean;
};

export const findSolidByText = (
  doc: Document,
  pattern: RegExp,
  options: FindSolidByTextOptions = {},
): FindSolidByTextResult => {
  const exact = options.exact === true;
  const result = walkSolidDom<string>(
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
      ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
    },
  );

  const matches: SolidTextMatch[] = result.matches.map((mm) =>
    Object.freeze({ locator: mm.locator, tag: mm.tag, matchedText: mm.extra }),
  );

  return Object.freeze({ matches, truncated: result.truncated });
};
