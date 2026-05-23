/**
 * Framework-agnostic DOM/ARIA selector primitives, extracted from react/find.ts
 * once findByRole gained a second caller (Vue). Pure DOM reads — no React, no
 * Vue, no chrome.*. react/find.ts re-exports these for its existing importers;
 * vue/find_by_role imports them directly.
 */

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
 * sufficient for selector matching. Returns undefined when no name.
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
