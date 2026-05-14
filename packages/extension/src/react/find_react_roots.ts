import { REACT_CONTAINER_KEY_PREFIX } from './types.js';

const hasContainerKey = (el: Element): boolean => {
  for (const key of Object.keys(el)) {
    if (key.startsWith(REACT_CONTAINER_KEY_PREFIX)) return true;
  }
  return false;
};

export const findReactRoots = (doc: Document): Element[] => {
  const roots: Element[] = [];
  const all = doc.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el !== undefined && hasContainerKey(el)) roots.push(el);
  }
  return roots;
};
