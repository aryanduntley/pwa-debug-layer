/**
 * Locate Svelte components by rendered text (parity-in-spirit with
 * react/vue findByText, but match identity is the component .svelte file).
 * pattern is a pre-compiled RegExp (handler owns compilation); pure, never
 * throws. Matches are one-per-component-file.
 */
import { walkSvelteDom } from './find.js';

export type FindSvelteByTextOptions = {
  readonly exact?: boolean;
  readonly maxMatches?: number;
};

export type FindSvelteByTextMatch = {
  /** Owning component .svelte file (also the stable id). */
  readonly stableId: string;
  readonly file: string;
  readonly matchedText: string;
};

export type FindSvelteByTextResult = {
  readonly matches: FindSvelteByTextMatch[];
  readonly truncated: boolean;
};

export const findSvelteByText = (
  doc: Document,
  pattern: RegExp,
  options: FindSvelteByTextOptions = {},
): FindSvelteByTextResult => {
  const exact = options.exact === true;
  const result = walkSvelteDom<string>(
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

  const matches: FindSvelteByTextMatch[] = result.matches.map((mm) =>
    Object.freeze({ stableId: mm.file, file: mm.file, matchedText: mm.extra }),
  );

  return Object.freeze({ matches, truncated: result.truncated });
};
