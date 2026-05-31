// resolveLocator — the single entry the action-tool handlers call to turn a
// Locator into one element (or a typed failure) before applying a dom_actions
// primitive. Strategy is chosen by field precedence: selector > role > text >
// stableId.

import { bySelector, byRole, byText } from './strategies.js';
import { resolveByStableId } from './stable_id.js';
import type { Locator, LocatorResult } from './types.js';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Apply nth / requireUnique / first-with-ambiguity / not-found selection. */
export const selectMatch = (
  elements: Element[],
  locator: Locator,
  describedBy: string,
): LocatorResult => {
  const matchCount = elements.length;
  if (matchCount === 0) {
    return { ok: false, error: `no element matched (${describedBy})`, matchCount: 0 };
  }
  if (locator.nth !== undefined) {
    const el = elements[locator.nth];
    if (el === undefined) {
      return {
        ok: false,
        error: `nth=${locator.nth} out of range (${matchCount} matches for ${describedBy})`,
        matchCount,
      };
    }
    return { ok: true, element: el, matchCount, describedBy: `${describedBy} [nth=${locator.nth}]` };
  }
  const first = elements[0];
  if (first === undefined) {
    return { ok: false, error: `no element matched (${describedBy})`, matchCount: 0 };
  }
  if (matchCount > 1) {
    if (locator.requireUnique) {
      return {
        ok: false,
        error: `ambiguous: ${matchCount} matches for ${describedBy} — pass nth or unset requireUnique`,
        matchCount,
      };
    }
    return { ok: true, element: first, matchCount, describedBy: `${describedBy} (first of ${matchCount})` };
  }
  return { ok: true, element: first, matchCount, describedBy };
};

/** Resolve a Locator to a single element (or typed failure). */
export const resolveLocator = (doc: Document, locator: Locator): LocatorResult => {
  if (locator.selector !== undefined) {
    return selectMatch(bySelector(doc, locator.selector), locator, `selector "${locator.selector}"`);
  }

  if (locator.role !== undefined) {
    const nameRe =
      locator.name !== undefined ? new RegExp(escapeRegExp(locator.name)) : undefined;
    const desc = `role "${locator.role}"${locator.name !== undefined ? ` name~"${locator.name}"` : ''}`;
    return selectMatch(byRole(doc, locator.role, nameRe), locator, desc);
  }

  if (locator.text !== undefined) {
    const esc = escapeRegExp(locator.text);
    const re = locator.exact ? new RegExp(`^${esc}$`) : new RegExp(esc);
    const desc = `text ${locator.exact ? '=' : '~'}"${locator.text}"`;
    return selectMatch(byText(doc, re), locator, desc);
  }

  if (locator.stableId !== undefined) {
    const framework = locator.framework ?? 'dom';
    if (framework === 'svelte') {
      return {
        ok: false,
        error:
          'svelte stableId is a component file, not a single element — use role/text/selector instead',
        matchCount: 0,
      };
    }
    return selectMatch(
      resolveByStableId(doc, framework, locator.stableId),
      locator,
      `${framework} stableId "${locator.stableId}"`,
    );
  }

  return { ok: false, error: 'locator has no selector/role/text/stableId', matchCount: 0 };
};
