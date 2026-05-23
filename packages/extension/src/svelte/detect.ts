/**
 * Feature-detect Svelte on the page. Svelte exposes no stable production
 * introspection surface, so detection looks for: (1) the Svelte 5 dev global
 * window.__svelte, and (2) the presence of dev-only __svelte_meta on rendered
 * elements (the only thing that makes discovery possible). `dev` reports
 * whether introspection is actually viable; `present` may be true with
 * dev:false for a production build.
 */
import { SVELTE_GLOBAL_KEY, SVELTE_META_KEY, type SvelteDetection } from './types.js';

type SvelteScope = { readonly [SVELTE_GLOBAL_KEY]?: unknown };

const hasGlobal = (scope: SvelteScope): boolean => {
  try {
    return scope[SVELTE_GLOBAL_KEY] != null;
  } catch {
    return false;
  }
};

/** Count rendered elements carrying __svelte_meta (dev-only signal). */
const countMetaElements = (doc: Document): number => {
  let count = 0;
  let all: ArrayLike<Element>;
  try {
    all = doc.querySelectorAll('*');
  } catch {
    return 0;
  }
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el === undefined) continue;
    try {
      if ((el as unknown as Record<string, unknown>)[SVELTE_META_KEY] != null) count += 1;
    } catch {
      // ignore exotic elements
    }
  }
  return count;
};

export const detectSvelte = (
  scope: SvelteScope,
  doc: Document,
): SvelteDetection => {
  const metaElementCount = countMetaElements(doc);
  const present = hasGlobal(scope) || metaElementCount > 0;
  return Object.freeze({
    present,
    dev: metaElementCount > 0,
    metaElementCount,
  });
};
