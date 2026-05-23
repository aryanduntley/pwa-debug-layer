import { VUE_APP_KEY } from './types.js';

/** True when an element carries a `__vue_app__` (i.e. it is a Vue mount root). */
const isVueRoot = (el: Element): boolean => {
  try {
    return (el as unknown as Record<string, unknown>)[VUE_APP_KEY] != null;
  } catch {
    return false;
  }
};

/** All Vue mount-container elements in the document, in document order. */
export const findVueRoots = (doc: Document): Element[] => {
  const roots: Element[] = [];
  const all = doc.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el !== undefined && isVueRoot(el)) roots.push(el);
  }
  return roots;
};
