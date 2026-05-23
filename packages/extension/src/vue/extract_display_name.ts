import type { ComponentInternalInstance } from './types.js';

/** Strip directory + query + extension from a `__file` path → bare base name. */
const basename = (file: string): string => {
  const noQuery = file.split('?')[0] ?? file;
  const seg = noQuery.split(/[\\/]/).pop() ?? noQuery;
  return seg.replace(/\.\w+$/, '');
};

/**
 * Component display name, preferring an explicit `name` (defineOptions /
 * options API), then the <script setup> compiler-injected `__name`, then the
 * `__file` base name. 'Anonymous' when none is resolvable.
 */
export const extractDisplayName = (
  instance: ComponentInternalInstance,
): string => {
  const type = instance.type;
  if (type !== null && (typeof type === 'object' || typeof type === 'function')) {
    const o = type as { name?: unknown; __name?: unknown; __file?: unknown };
    if (typeof o.name === 'string' && o.name.length > 0) return o.name;
    if (typeof o.__name === 'string' && o.__name.length > 0) return o.__name;
    if (typeof o.__file === 'string' && o.__file.length > 0) {
      const b = basename(o.__file);
      if (b.length > 0) return b;
    }
  }
  return 'Anonymous';
};
