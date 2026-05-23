/**
 * Defensive readers over Svelte's dev-only `el.__svelte_meta`. Every access is
 * try/guarded — these properties are dev-only and may be absent or exotic, and
 * introspection must never throw on a page that merely happens to use Svelte.
 */
import {
  SVELTE_META_KEY,
  type SvelteMeta,
  type SvelteLoc,
} from './types.js';

const isLoc = (v: unknown): v is SvelteLoc =>
  v !== null && typeof v === 'object' && typeof (v as { file?: unknown }).file === 'string';

/** Read `el.__svelte_meta` as a SvelteMeta, or undefined when absent/malformed. */
export const getSvelteMeta = (el: Element): SvelteMeta | undefined => {
  try {
    const raw = (el as unknown as Record<string, unknown>)[SVELTE_META_KEY];
    if (raw === null || typeof raw !== 'object') return undefined;
    const loc = (raw as { loc?: unknown }).loc;
    return isLoc(loc) ? { loc } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The .svelte source file of the component that rendered `el`: the nearest
 * self-or-ancestor element carrying __svelte_meta. Svelte tags each element
 * with its OWN component file, so the closest meta up the tree names the
 * owning component. Returns undefined when no ancestor carries meta.
 */
export const componentFileForNode = (el: Element): string | undefined => {
  let cursor: Element | null = el;
  while (cursor !== null) {
    const meta = getSvelteMeta(cursor);
    if (meta !== undefined) return meta.loc.file;
    cursor = cursor.parentElement;
  }
  return undefined;
};
