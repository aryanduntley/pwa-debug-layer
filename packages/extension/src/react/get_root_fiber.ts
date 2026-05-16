import type { Fiber } from './types.js';
import { REACT_CONTAINER_KEY_PREFIX, REACT_FIBER_KEY_PREFIX } from './types.js';

const HOST_ROOT_TAG = 3;

const readKeyValue = (el: Element, prefix: string): unknown => {
  let keys: string[];
  try {
    keys = Object.keys(el);
  } catch {
    return undefined;
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    if (!key.startsWith(prefix)) continue;
    try {
      return (el as unknown as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const climbToHostRoot = (fiber: Fiber): Fiber | undefined => {
  if (fiber.tag === HOST_ROOT_TAG) return fiber;
  let cursor: Fiber | null = fiber.return;
  while (cursor !== null) {
    if (cursor.tag === HOST_ROOT_TAG) return cursor;
    cursor = cursor.return;
  }
  return undefined;
};

const isFiberLike = (value: unknown): value is Fiber =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { tag?: unknown }).tag === 'number';

// Resolve the committed HostRoot fiber from a value attached under
// __reactContainer$*. That value can be either:
//   (a) a FiberRoot — { current } points at the HostRoot fiber (the shape
//       earlier notes assumed; still produced by some paths/synthetic tests); or
//   (b) the HostRoot fiber itself — what React 18 `createRoot` actually
//       attaches. Under React's double-buffering the directly-attached fiber
//       may be the work-in-progress/alternate copy with no child; the committed
//       tree lives at fiber.stateNode.current (i.e. FiberRoot.current).
// (c) falls back to treating a bare fiber-like value as the root directly
//     (legacy / synthetic). A non-fiber object (e.g. {}) yields undefined so
//     it is never handed to climbToHostRoot.
const resolveHostRoot = (value: unknown): Fiber | undefined => {
  if (value === null || value === undefined) return undefined;
  const v = value as {
    current?: unknown;
    stateNode?: { current?: unknown } | null;
  };

  const current = v.current;
  if (current !== null && current !== undefined) {
    return climbToHostRoot(current as Fiber);
  }

  const committed = v.stateNode != null ? v.stateNode.current : undefined;
  if (committed !== null && committed !== undefined) {
    return climbToHostRoot(committed as Fiber);
  }

  if (isFiberLike(value)) {
    return climbToHostRoot(value);
  }

  return undefined;
};

const hasChildFiber = (fiber: Fiber | undefined): boolean =>
  fiber !== undefined &&
  (fiber as { child?: unknown }).child !== null &&
  (fiber as { child?: unknown }).child !== undefined;

// Strategy 3 (most defect-resistant): climb to the HostRoot from the first
// descendant host node carrying a __reactFiber$* back-pointer. React sets
// __reactFiber$ on *mounted* host nodes, so this path is always rooted in the
// committed tree — it corroborates / falls back from the container-key
// strategies when those land on a stale or double-buffered alternate.
// Guarded so synthetic (non-DOM) test elements simply skip it.
const rootFromDescendantFiber = (rootEl: Element): Fiber | undefined => {
  let nodes: ArrayLike<Element>;
  try {
    if (typeof rootEl.querySelectorAll !== 'function') return undefined;
    nodes = rootEl.querySelectorAll('*');
  } catch {
    return undefined;
  }
  const limit = Math.min(nodes.length, 50);
  for (let i = 0; i < limit; i++) {
    const node = nodes[i];
    if (node === undefined) continue;
    const fiber = readKeyValue(node, REACT_FIBER_KEY_PREFIX);
    if (fiber !== undefined && fiber !== null) {
      const host = climbToHostRoot(fiber as Fiber);
      if (host !== undefined) return host;
    }
  }
  return undefined;
};

// Resolve the HostRoot via three independent strategies and prefer whichever
// yields a *walkable* tree. A HostRoot with no child is the known-defective
// outcome (e.g. React 18's double-buffered alternate attached under
// __reactContainer$) — discard it in favour of a strategy that produces a
// real subtree. Tie-break order container > fiber-key > descendant preserves
// behaviour for genuinely childless / synthetic-test roots.
export const getRootFiber = (rootEl: Element): Fiber | undefined => {
  const fromContainer = resolveHostRoot(
    readKeyValue(rootEl, REACT_CONTAINER_KEY_PREFIX),
  );

  const fiberKeyValue = readKeyValue(rootEl, REACT_FIBER_KEY_PREFIX);
  const fromFiberKey =
    fiberKeyValue !== undefined && fiberKeyValue !== null
      ? climbToHostRoot(fiberKeyValue as Fiber)
      : undefined;

  const fromDescendant = rootFromDescendantFiber(rootEl);

  const ordered = [fromContainer, fromFiberKey, fromDescendant];
  for (const candidate of ordered) {
    if (hasChildFiber(candidate)) return candidate;
  }
  for (const candidate of ordered) {
    if (candidate !== undefined) return candidate;
  }
  return undefined;
};
