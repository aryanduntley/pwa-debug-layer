/**
 * Locate Svelte components by ARIA role (reusing the shared dom_aria role/name
 * logic). Match identity is the component .svelte file. nameRe is a pre-compiled
 * RegExp (handler owns compilation); pure, never throws. One match per file.
 */
import { walkSvelteDom } from './find.js';
import {
  implicitRoleForElement,
  computeAccessibleName,
} from '../dom_aria/aria.js';

export type FindSvelteByRoleOptions = {
  readonly maxMatches?: number;
};

export type FindSvelteByRoleMatch = {
  /** Owning component .svelte file (also the stable id). */
  readonly stableId: string;
  readonly file: string;
  readonly role: string;
  readonly name?: string;
};

export type FindSvelteByRoleResult = {
  readonly matches: FindSvelteByRoleMatch[];
  readonly truncated: boolean;
};

export const findSvelteByRole = (
  doc: Document,
  role: string,
  nameRe: RegExp | undefined,
  options: FindSvelteByRoleOptions = {},
): FindSvelteByRoleResult => {
  const result = walkSvelteDom<{ readonly name?: string }>(
    doc,
    (el) => {
      if (implicitRoleForElement(el) !== role) return null;
      const accName = computeAccessibleName(el);
      if (nameRe !== undefined) {
        if (accName === undefined || !nameRe.test(accName)) return null;
      }
      return accName !== undefined ? { name: accName } : {};
    },
    {
      ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
    },
  );

  const matches: FindSvelteByRoleMatch[] = result.matches.map((mm) =>
    Object.freeze({
      stableId: mm.file,
      file: mm.file,
      role,
      ...(mm.extra.name !== undefined ? { name: mm.extra.name } : {}),
    }),
  );

  return Object.freeze({ matches, truncated: result.truncated });
};
