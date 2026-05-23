import type { ComponentInternalInstance } from './types.js';
import { collectChildInstances } from './collect_child_instances.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';

/**
 * 0-based occurrence index of an unkeyed instance among its prior UNKEYED
 * siblings sharing the same display name — the exact inverse of
 * resolve_stable_id's childAtIndex predicate, so computeStableId's unkeyed
 * discriminator round-trips. Siblings are the parent's child instances (Vue has
 * no $children, so they are recomputed from the parent's subTree). Returns 0
 * for a root instance (parent === null) or one unreachable in the parent.
 */
export const unkeyedOccurrence = (
  instance: ComponentInternalInstance,
): number => {
  const parent = instance.parent;
  if (parent === null) return 0;
  const name = extractDisplayName(instance);
  let occurrence = 0;
  for (const sib of collectChildInstances(parent)) {
    if (sib === instance) return occurrence;
    if (extractKey(sib) === undefined && extractDisplayName(sib) === name) {
      occurrence += 1;
    }
  }
  return 0;
};
