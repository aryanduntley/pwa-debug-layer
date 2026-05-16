import type { Fiber } from './types.js';
import { findReactRoots } from './find_react_roots.js';
import { getRootFiber } from './get_root_fiber.js';
import { computeStableId } from './compute_stable_id.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';
import {
  walkAndFilter,
  implicitRoleForElement,
  computeAccessibleName,
} from './find.js';

const DEFAULT_MAX_MATCHES = 20;

export type FindByRoleOptions = {
  readonly rootIndex?: number;
  readonly maxMatches?: number;
};

export type FindByRoleMatch = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly role: string;
  /** The computed accessible name, when the element has one. */
  readonly name?: string;
};

export type FindByRoleResult = {
  readonly matches: FindByRoleMatch[];
  readonly truncated: boolean;
  readonly rootCount: number;
};

/**
 * Find React HostComponent fibers whose host node has a given ARIA role
 * (explicit role attribute or the simplified implicit-role mapping), optionally
 * narrowed by an accessible-name regex. Mirrors findByText's root resolution +
 * per-root walkAndFilter composition so each match gets the correct
 * root-scoped stableId. nameRe is a pre-compiled RegExp (the page-world
 * handler owns compilation + regex-error shaping) so this stays pure.
 */
export const findByRole = (
  doc: Document,
  role: string,
  nameRe: RegExp | undefined,
  options: FindByRoleOptions = {},
): FindByRoleResult => {
  const rootEls = findReactRoots(doc);
  const rootCount = rootEls.length;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;

  const selectedIndices: number[] =
    options.rootIndex === undefined
      ? rootEls.map((_, i) => i)
      : options.rootIndex >= 0 && options.rootIndex < rootCount
        ? [options.rootIndex]
        : [];

  const matches: FindByRoleMatch[] = [];
  let truncated = false;

  for (const i of selectedIndices) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    const rootEl = rootEls[i];
    if (rootEl === undefined) continue;
    const rootFiber = getRootFiber(rootEl);
    if (rootFiber === undefined) continue;

    const names = new Map<Fiber, string | undefined>();
    const result = walkAndFilter(
      [rootFiber],
      (fiber, hostNode) => {
        if (implicitRoleForElement(hostNode) !== role) return false;
        const accName = computeAccessibleName(hostNode);
        if (nameRe !== undefined) {
          if (accName === undefined || !nameRe.test(accName)) return false;
        }
        names.set(fiber, accName);
        return true;
      },
      { maxMatches: maxMatches - matches.length },
    );

    for (const fm of result.matches) {
      const key = extractKey(fm.fiber);
      const name = names.get(fm.fiber);
      matches.push(
        Object.freeze({
          stableId: computeStableId(fm.fiber, i),
          displayName: extractDisplayName(fm.fiber),
          ...(key !== undefined ? { key } : {}),
          role,
          ...(name !== undefined ? { name } : {}),
        }),
      );
    }
    if (result.truncated) truncated = true;
  }

  return Object.freeze({ matches, truncated, rootCount });
};
