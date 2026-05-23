/**
 * Locate elements by ARIA role on a Solid page (reusing the shared dom_aria
 * role/name logic). ELEMENT-level (Solid has no component identity): returns
 * each matching node's locator + tag + role + accessible name. nameRe is a
 * pre-compiled RegExp; pure.
 */
import { walkSolidDom } from './find.js';
import {
  implicitRoleForElement,
  computeAccessibleName,
} from '../dom_aria/aria.js';
import type { SolidRoleMatch } from './types.js';

export type FindSolidByRoleOptions = {
  readonly maxMatches?: number;
};

export type FindSolidByRoleResult = {
  readonly matches: SolidRoleMatch[];
  readonly truncated: boolean;
};

export const findSolidByRole = (
  doc: Document,
  role: string,
  nameRe: RegExp | undefined,
  options: FindSolidByRoleOptions = {},
): FindSolidByRoleResult => {
  const result = walkSolidDom<{ readonly name?: string }>(
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

  const matches: SolidRoleMatch[] = result.matches.map((mm) =>
    Object.freeze({
      locator: mm.locator,
      tag: mm.tag,
      role,
      ...(mm.extra.name !== undefined ? { name: mm.extra.name } : {}),
    }),
  );

  return Object.freeze({ matches, truncated: result.truncated });
};
