import type { Fiber } from './types.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';

// 0-based occurrence index of an unkeyed fiber among its prior UNKEYED
// siblings that share the same extractDisplayName. This is the exact inverse
// of resolve_stable_id.childAtIndex's predicate
// (extractKey === undefined && extractDisplayName === name), so
// computeStableId's unkeyed discriminator round-trips with resolveStableId on
// real heterogeneous sibling sets. Returns 0 for a parentless fiber or one
// unreachable in the parent.child chain (malformed tree) — matching the prior
// max(siblingPosition, 0) floor for those cases.
export const unkeyedOccurrence = (fiber: Fiber): number => {
  const parent = fiber.return;
  if (parent === null) return 0;

  const name = extractDisplayName(fiber);
  let occurrence = 0;
  let cursor: Fiber | null = parent.child;
  while (cursor !== null) {
    if (cursor === fiber) return occurrence;
    if (extractKey(cursor) === undefined && extractDisplayName(cursor) === name) {
      occurrence += 1;
    }
    cursor = cursor.sibling;
  }
  return 0;
};
