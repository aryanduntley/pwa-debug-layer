/**
 * Locate Vue components by ARIA role — parity with react/find_by_role, over the
 * Vue DOM-walk primitive. Matches elements whose role (explicit attr or the
 * dom_aria implicit mapping) equals `role`, optionally narrowed by an
 * accessible-name regex, then maps each to its owning component and returns
 * root-scoped stable ids. The role/name logic is the shared dom_aria module —
 * identical to react.findByRole.
 *
 * nameRe is a pre-compiled RegExp (the page-world handler owns compilation +
 * regex-error shaping) so this function is pure and never throws.
 */
import { walkVueDom } from './find.js';
import {
  implicitRoleForElement,
  computeAccessibleName,
} from '../dom_aria/aria.js';
import { computeStableId } from './compute_stable_id.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';

export type FindVueByRoleOptions = {
  readonly rootIndex?: number;
  readonly maxMatches?: number;
};

export type FindVueByRoleMatch = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly role: string;
  /** The computed accessible name, when the element has one. */
  readonly name?: string;
};

export type FindVueByRoleResult = {
  readonly matches: FindVueByRoleMatch[];
  readonly truncated: boolean;
  readonly rootCount: number;
};

export const findVueByRole = (
  doc: Document,
  role: string,
  nameRe: RegExp | undefined,
  options: FindVueByRoleOptions = {},
): FindVueByRoleResult => {
  // Object payload so a match with NO accessible name ({}) is still non-null
  // and distinguishable from a non-match (null).
  const result = walkVueDom<{ readonly name?: string }>(
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
      ...(options.rootIndex !== undefined ? { rootIndex: options.rootIndex } : {}),
      ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
    },
  );

  const matches: FindVueByRoleMatch[] = result.matches.map((mm) => {
    const key = extractKey(mm.instance);
    return Object.freeze({
      stableId: computeStableId(mm.instance, mm.rootIndex),
      displayName: extractDisplayName(mm.instance),
      ...(key !== undefined ? { key } : {}),
      role,
      ...(mm.extra.name !== undefined ? { name: mm.extra.name } : {}),
    });
  });

  return Object.freeze({
    matches,
    truncated: result.truncated,
    rootCount: result.rootCount,
  });
};
