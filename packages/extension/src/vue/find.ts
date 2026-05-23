/**
 * Vue DOM-walk primitive shared by vue.findByText and vue.findByRole — the Vue
 * analogue of react/find.ts's walkAndFilter, but inverted to match Vue's model:
 * Vue has no per-host-node component, so instead of walking a component tree we
 * walk the rendered DOM under each Vue mount root and map each matching element
 * back to its OWNING component instance via getInstanceForNode
 * (el.__vueParentComponent). Matches are de-duped by instance (many DOM nodes
 * can belong to one component) and carry the rootIndex so callers can compute a
 * root-scoped stable id.
 *
 * Pure: DOM reads only, no mutation. The predicate is caller-supplied and
 * returns the per-match payload (or null to skip).
 */
import { findVueRoots } from './find_vue_roots.js';
import { getInstanceForNode } from './get_instance_for_node.js';
import type { ComponentInternalInstance } from './types.js';

const DEFAULT_MAX_MATCHES = 20;

export type VueDomMatch<E> = {
  readonly instance: ComponentInternalInstance;
  readonly rootIndex: number;
  readonly extra: E;
};

export type WalkVueDomOptions = {
  readonly rootIndex?: number;
  readonly maxMatches?: number;
};

export type WalkVueDomResult<E> = {
  readonly matches: VueDomMatch<E>[];
  readonly truncated: boolean;
  readonly rootCount: number;
};

/**
 * Walk the rendered DOM under each selected Vue root. For every element the
 * predicate accepts (returns non-null), map it to its owning component instance
 * and record one match per DISTINCT instance (first wins, document order),
 * capped at maxMatches. `truncated` is set when the cap is reached while
 * candidates remain.
 */
export const walkVueDom = <E>(
  doc: Document,
  predicate: (el: Element) => E | null,
  options: WalkVueDomOptions = {},
): WalkVueDomResult<E> => {
  const rootEls = findVueRoots(doc);
  const rootCount = rootEls.length;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;

  const selectedIndices: number[] =
    options.rootIndex === undefined
      ? rootEls.map((_, i) => i)
      : options.rootIndex >= 0 && options.rootIndex < rootCount
        ? [options.rootIndex]
        : [];

  const matches: VueDomMatch<E>[] = [];
  const seen = new Set<ComponentInternalInstance>();
  let truncated = false;

  for (const i of selectedIndices) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    const rootEl = rootEls[i];
    if (rootEl === undefined) continue;
    // Root element itself, then its descendants — document (preorder) order.
    const els: Element[] = [rootEl, ...Array.from(rootEl.querySelectorAll('*'))];
    for (const el of els) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      const extra = predicate(el);
      if (extra === null) continue;
      const instance = getInstanceForNode(el);
      if (instance === undefined || seen.has(instance)) continue;
      seen.add(instance);
      matches.push({ instance, rootIndex: i, extra });
    }
  }

  return { matches, truncated, rootCount };
};
