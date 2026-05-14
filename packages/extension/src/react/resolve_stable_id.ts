import type { Fiber } from './types.js';
import { getFiberForNode } from './get_fiber_for_node.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';

const ROOT_SEGMENT = /^root(\d+)$/;
const CHILD_SEGMENT = /^(.+)\[(.*)\]$/;

const isNumericString = (s: string): boolean => s.length > 0 && /^\d+$/.test(s);

const childAtIndex = (parent: Fiber, name: string, index: number): Fiber | undefined => {
  let cursor: Fiber | null = parent.child;
  let matchedCount = 0;
  while (cursor !== null) {
    if (extractKey(cursor) === undefined && extractDisplayName(cursor) === name) {
      if (matchedCount === index) return cursor;
      matchedCount += 1;
    }
    cursor = cursor.sibling;
  }
  return undefined;
};

const childByKey = (parent: Fiber, name: string, key: string): Fiber | undefined => {
  let cursor: Fiber | null = parent.child;
  while (cursor !== null) {
    if (extractDisplayName(cursor) === name && extractKey(cursor) === key) return cursor;
    cursor = cursor.sibling;
  }
  return undefined;
};

const rootFiberFor = (rootEl: Element): Fiber | undefined => {
  const containerFiber = getFiberForNode(rootEl);
  if (containerFiber === undefined) return undefined;
  if (containerFiber.tag === 3) return containerFiber;
  let cursor: Fiber | null = containerFiber.return;
  while (cursor !== null) {
    if (cursor.tag === 3) return cursor;
    cursor = cursor.return;
  }
  return containerFiber;
};

export const resolveStableId = (stableId: string, roots: Element[]): Fiber | undefined => {
  const segments = stableId.split('/');
  if (segments.length === 0) return undefined;

  const head = segments[0];
  if (head === undefined) return undefined;
  const rootMatch = ROOT_SEGMENT.exec(head);
  if (rootMatch === null) return undefined;
  const rootIndexStr = rootMatch[1];
  if (rootIndexStr === undefined) return undefined;
  const rootIndex = Number.parseInt(rootIndexStr, 10);
  if (rootIndex < 0 || rootIndex >= roots.length) return undefined;

  const rootEl = roots[rootIndex];
  if (rootEl === undefined) return undefined;
  const rootFiber = rootFiberFor(rootEl);
  if (rootFiber === undefined) return undefined;

  let current: Fiber = rootFiber;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) return undefined;
    const m = CHILD_SEGMENT.exec(seg);
    if (m === null) return undefined;
    const name = m[1];
    const discriminator = m[2];
    if (name === undefined || discriminator === undefined) return undefined;

    const next = isNumericString(discriminator)
      ? childAtIndex(current, name, Number.parseInt(discriminator, 10))
      : childByKey(current, name, discriminator);

    if (next === undefined) return undefined;
    current = next;
  }
  return current;
};
