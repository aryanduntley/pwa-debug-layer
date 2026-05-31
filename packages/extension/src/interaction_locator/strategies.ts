// Framework-agnostic element resolution strategies.
//
// Role and text matching are pure DOM/ARIA concerns — the same dom_aria
// predicates react.findByRole and vue.findByRole already share — so the locator
// applies them across the whole document regardless of framework. Only stableId
// (see stable_id.ts) needs per-framework dispatch.

import {
  implicitRoleForElement,
  computeAccessibleName,
} from '../dom_aria/aria.js';

/** All elements matching a CSS selector; [] on an invalid selector. */
export const bySelector = (doc: Document, selector: string): Element[] => {
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch {
    return [];
  }
};

/** Elements whose ARIA role equals `role`, optionally narrowed by a name regex. */
export const byRole = (
  doc: Document,
  role: string,
  nameRe?: RegExp,
): Element[] => {
  const out: Element[] = [];
  const all = doc.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el === undefined) continue;
    if (implicitRoleForElement(el) !== role) continue;
    if (nameRe !== undefined) {
      const accName = computeAccessibleName(el);
      if (accName === undefined || !nameRe.test(accName)) continue;
    }
    out.push(el);
  }
  return out;
};

/**
 * Leaf-most elements whose OWN direct text-node content matches `re`. Matching
 * on direct text (not textContent) avoids also selecting every ancestor that
 * merely contains the text deeper in its subtree.
 */
export const byText = (doc: Document, re: RegExp): Element[] => {
  const out: Element[] = [];
  const all = doc.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el === undefined) continue;
    let direct = '';
    for (let n = 0; n < el.childNodes.length; n++) {
      const node = el.childNodes[n];
      if (node !== undefined && node.nodeType === 3) direct += node.textContent ?? '';
    }
    if (re.test(direct.trim())) out.push(el);
  }
  return out;
};
