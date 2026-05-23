import type { ComponentInternalInstance } from './types.js';
import { getRootInstance } from './get_root_instance.js';
import { collectChildInstances } from './collect_child_instances.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';

const ROOT_SEGMENT = /^root(\d+)$/;
const CHILD_SEGMENT = /^(.+)\[(.*)\]$/;
const isNumericString = (s: string): boolean => s.length > 0 && /^\d+$/.test(s);

type Seg = { readonly name: string; readonly disc: string };

const parseSegment = (seg: string): Seg | undefined => {
  const m = CHILD_SEGMENT.exec(seg);
  if (m === null) return undefined;
  const name = m[1];
  const disc = m[2];
  if (name === undefined || disc === undefined) return undefined;
  return { name, disc };
};

const childByKey = (
  parent: ComponentInternalInstance,
  name: string,
  key: string,
): ComponentInternalInstance | undefined =>
  collectChildInstances(parent).find(
    (c) => extractDisplayName(c) === name && extractKey(c) === key,
  );

const childAtIndex = (
  parent: ComponentInternalInstance,
  name: string,
  index: number,
): ComponentInternalInstance | undefined => {
  let matched = 0;
  for (const c of collectChildInstances(parent)) {
    if (extractKey(c) === undefined && extractDisplayName(c) === name) {
      if (matched === index) return c;
      matched += 1;
    }
  }
  return undefined;
};

// A numeric discriminator is ambiguous (a numeric vnode key vs an unkeyed
// occurrence index): try the keyed child first, then the unkeyed-occurrence
// child — mirroring react resolve_stable_id. Keyed wins on residual ambiguity.
const findChild = (
  parent: ComponentInternalInstance,
  { name, disc }: Seg,
): ComponentInternalInstance | undefined =>
  isNumericString(disc)
    ? (childByKey(parent, name, disc) ??
      childAtIndex(parent, name, Number.parseInt(disc, 10)))
    : childByKey(parent, name, disc);

/**
 * Inverse of computeStableId: resolve a stable id back to its live instance.
 * `root{i}` selects the mount root; segment[1] addresses the root component
 * instance itself (Vue's getRootInstance IS the root component, so its name is
 * validated against current rather than searched as a child); segments[2…]
 * descend via collectChildInstances. Returns undefined on any mismatch.
 */
export const resolveStableId = (
  stableId: string,
  roots: Element[],
): ComponentInternalInstance | undefined => {
  const segments = stableId.split('/');
  const head = segments[0];
  if (head === undefined) return undefined;
  const rootMatch = ROOT_SEGMENT.exec(head);
  if (rootMatch === null || rootMatch[1] === undefined) return undefined;
  const rootIndex = Number.parseInt(rootMatch[1], 10);
  if (rootIndex < 0 || rootIndex >= roots.length) return undefined;
  const rootEl = roots[rootIndex];
  if (rootEl === undefined) return undefined;

  let current = getRootInstance(rootEl);
  if (current === undefined) return undefined;

  const rootSeg = segments[1];
  if (rootSeg !== undefined) {
    const parsed = parseSegment(rootSeg);
    if (parsed === undefined) return undefined;
    if (extractDisplayName(current) !== parsed.name) return undefined;
  }

  for (let i = 2; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) return undefined;
    const parsed = parseSegment(seg);
    if (parsed === undefined) return undefined;
    const next = findChild(current, parsed);
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
};
