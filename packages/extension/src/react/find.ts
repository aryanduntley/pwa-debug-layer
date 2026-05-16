import type { Fiber } from './types.js';
import { walkFiber } from './walk_fiber.js';

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

const explicitRole = (el: Element): string | undefined => {
  const attr = el.getAttribute('role');
  if (attr === null) return undefined;
  const token = attr.trim().split(/\s+/)[0];
  return token !== undefined && token.length > 0 ? token : undefined;
};

const inputRole = (el: Element): string => {
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  switch (type) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return 'button';
    case 'search':
      return 'searchbox';
    case 'number':
      return 'spinbutton';
    case 'range':
      return 'slider';
    default:
      return 'textbox';
  }
};

/**
 * Map a DOM Element to its ARIA role. An explicit `role` attribute always wins;
 * otherwise an implicit role is derived from the element's tag (a simplified
 * WAI-ARIA subset covering the common interactive/landmark/heading cases —
 * NOT the full host-language role mapping). Returns undefined when no role
 * applies (e.g. <a> without href, <div>, unmapped tags).
 */
export const implicitRoleForElement = (el: Element): string | undefined => {
  const explicit = explicitRole(el);
  if (explicit !== undefined) return explicit;

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button':
      return 'button';
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : undefined;
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    case 'aside':
      return 'complementary';
    case 'section':
      return 'region';
    case 'article':
      return 'article';
    case 'form':
      return 'form';
    case 'input':
      return inputRole(el);
    case 'textarea':
      return 'textbox';
    case 'select':
      return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'img':
      return 'img';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'progress':
      return 'progressbar';
    case 'output':
      return 'status';
    default:
      return undefined;
  }
};

/**
 * Simplified ARIA accessible-name computation: aria-label, then the resolved
 * text of the first aria-labelledby id reference, then the element's trimmed
 * textContent. This is intentionally NOT the full computed-name algorithm
 * (no recursion, no value/placeholder/title fallbacks, no multi-id labelledby);
 * sufficient for Path 3 selector matching. Returns undefined when no name.
 */
export const computeAccessibleName = (el: Element): string | undefined => {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null) {
    const trimmed = ariaLabel.trim();
    if (trimmed.length > 0) return trimmed;
  }

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const id = labelledBy.trim().split(/\s+/)[0];
    if (id !== undefined && id.length > 0) {
      const ref = el.ownerDocument?.getElementById(id);
      const refText = ref?.textContent?.trim();
      if (refText !== undefined && refText.length > 0) return refText;
    }
  }

  const text = el.textContent?.trim();
  return text !== undefined && text.length > 0 ? text : undefined;
};
