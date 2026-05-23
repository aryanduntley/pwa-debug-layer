/**
 * Discover the Svelte components rendered on the page by grouping every
 * __svelte_meta-tagged element by its source file. Svelte is one component per
 * .svelte file, so a distinct file == a distinct component definition; the file
 * path is the component's stable identity. This is coarser than the React/Vue
 * per-instance trees (Svelte exposes no instance objects — see the Path 5
 * research note), but it is the honest extent of what dev-mode Svelte offers.
 *
 * Pure: DOM reads only, never throws (delegates to the guarded getSvelteMeta).
 */
import { getSvelteMeta } from './meta.js';
import type { SvelteComponent } from './types.js';

type Acc = {
  count: number;
  firstLoc?: { line?: number; column?: number };
};

/**
 * Group rendered DOM by component source file. Returns one SvelteComponent per
 * distinct file in first-seen (document) order, with element counts and the
 * first element's source line/column. Empty when no __svelte_meta is present
 * (production build, or not a Svelte page).
 */
export const discoverSvelteComponents = (doc: Document): SvelteComponent[] => {
  const byFile = new Map<string, Acc>();
  const order: string[] = [];

  let all: ArrayLike<Element>;
  try {
    all = doc.querySelectorAll('*');
  } catch {
    return [];
  }

  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el === undefined) continue;
    const meta = getSvelteMeta(el);
    if (meta === undefined) continue;
    const { file, line, column } = meta.loc;
    const existing = byFile.get(file);
    if (existing === undefined) {
      order.push(file);
      byFile.set(file, {
        count: 1,
        ...(line !== undefined || column !== undefined
          ? { firstLoc: { ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) } }
          : {}),
      });
    } else {
      existing.count += 1;
    }
  }

  return order.map((file) => {
    const acc = byFile.get(file) as Acc;
    return Object.freeze({
      stableId: file,
      file,
      ...(acc.firstLoc !== undefined ? { firstLoc: acc.firstLoc } : {}),
      elementCount: acc.count,
    });
  });
};
