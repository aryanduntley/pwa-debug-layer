import type { Fiber } from './types.js';
import { findReactRoots } from './find_react_roots.js';
import { getRootFiber } from './get_root_fiber.js';
import { computeStableId } from './compute_stable_id.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';
import { walkAndFilter } from './find.js';

const DEFAULT_MAX_MATCHES = 20;

export type FindByTextOptions = {
  readonly rootIndex?: number;
  /** true = the regex must match the FULL trimmed text; false = substring match. */
  readonly exact?: boolean;
  readonly maxMatches?: number;
};

export type FindByTextMatch = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  /** The matched substring (or the full trimmed text when exact:true). */
  readonly matchedText: string;
};

export type FindByTextResult = {
  readonly matches: FindByTextMatch[];
  readonly truncated: boolean;
  readonly rootCount: number;
};

/**
 * Find React HostComponent fibers whose host node's (trimmed) textContent
 * matches a regex. Composes the M22 walkAndFilter primitive once per selected
 * React root so each match can be assigned the correct root-scoped stableId
 * via computeStableId — the same root resolution + rootIndex scoping pattern
 * serializeTree uses (deferred from find.ts per the M22 T1 decision note).
 *
 * pattern is a pre-compiled RegExp (the page-world handler owns compilation +
 * regex-error shaping) so this function is pure and never throws.
 */
export const findByText = (
  doc: Document,
  pattern: RegExp,
  options: FindByTextOptions = {},
): FindByTextResult => {
  const rootEls = findReactRoots(doc);
  const rootCount = rootEls.length;
  const exact = options.exact === true;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;

  const selectedIndices: number[] =
    options.rootIndex === undefined
      ? rootEls.map((_, i) => i)
      : options.rootIndex >= 0 && options.rootIndex < rootCount
        ? [options.rootIndex]
        : [];

  const matches: FindByTextMatch[] = [];
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

    const matchedTexts = new Map<Fiber, string>();
    const result = walkAndFilter(
      [rootFiber],
      (fiber, hostNode) => {
        const text = (hostNode.textContent ?? '').trim();
        if (text.length === 0) return false;
        const m = pattern.exec(text);
        if (m === null) return false;
        if (exact && m[0] !== text) return false;
        matchedTexts.set(fiber, exact ? text : m[0]);
        return true;
      },
      { maxMatches: maxMatches - matches.length },
    );

    for (const fm of result.matches) {
      const key = extractKey(fm.fiber);
      matches.push(
        Object.freeze({
          stableId: computeStableId(fm.fiber, i),
          displayName: extractDisplayName(fm.fiber),
          ...(key !== undefined ? { key } : {}),
          matchedText: matchedTexts.get(fm.fiber) ?? '',
        }),
      );
    }
    if (result.truncated) truncated = true;
  }

  return Object.freeze({ matches, truncated, rootCount });
};
