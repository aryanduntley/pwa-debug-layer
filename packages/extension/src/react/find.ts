import type { Fiber } from './types.js';
import { walkFiber } from './walk_fiber.js';

// ARIA role/name primitives moved to the framework-agnostic dom_aria module
// (Path 5 M40) once vue.findByRole became a second caller. Re-exported here so
// existing importers (react/find_by_role) keep their `./find.js` import.
export {
  implicitRoleForElement,
  computeAccessibleName,
} from '../dom_aria/aria.js';

const HOST_COMPONENT_TAG = 5;

/**
 * A single fiber whose host DOM node satisfied a caller-supplied predicate.
 * Identity (stableId/displayName/key) is intentionally NOT carried here — callers
 * derive it via computeStableId/extractDisplayName/extractKey to avoid duplicating
 * the M20 identity scheme.
 */
export type FilterMatch = {
  readonly fiber: Fiber;
  readonly hostNode: Element;
};

export type WalkAndFilterOptions = {
  /** Cap on collected matches. Undefined = uncapped (truncated never set). */
  readonly maxMatches?: number;
};

export type WalkAndFilterResult = {
  readonly matches: FilterMatch[];
  /** True iff maxMatches was reached and the walk was still producing candidates. */
  readonly truncated: boolean;
};

const isElement = (node: unknown): node is Element =>
  node !== null &&
  typeof node === 'object' &&
  (node as { nodeType?: unknown }).nodeType === 1;

/**
 * Generic predicate-driven fiber walk shared by react.findByText and
 * react.findByRole. Walks each root subtree (reusing the walkFiber primitive),
 * and for every HostComponent fiber whose stateNode is a DOM Element, invokes
 * filterFn(fiber, hostNode); matches are collected until maxMatches is reached.
 *
 * Pure: no DOM mutation, no side effects beyond the returned arrays.
 */
export const walkAndFilter = (
  roots: readonly Fiber[],
  filterFn: (fiber: Fiber, hostNode: Element) => boolean,
  options: WalkAndFilterOptions = {},
): WalkAndFilterResult => {
  const cap = options.maxMatches;
  const matches: FilterMatch[] = [];
  let truncated = false;

  for (const root of roots) {
    walkFiber(root, (fiber) => {
      if (cap !== undefined && matches.length >= cap) {
        truncated = true;
        return false;
      }
      if (fiber.tag !== HOST_COMPONENT_TAG) return;
      const node = fiber.stateNode;
      if (!isElement(node)) return;
      if (filterFn(fiber, node)) matches.push({ fiber, hostNode: node });
      return;
    });
  }

  return { matches, truncated };
};
