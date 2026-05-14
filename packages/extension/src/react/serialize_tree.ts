import type { Fiber } from './types.js';
import { findReactRoots } from './find_react_roots.js';
import { getRootFiber } from './get_root_fiber.js';
import { computeStableId } from './compute_stable_id.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';

const DEFAULT_DEPTH_LIMIT = 8;
const DEFAULT_MAX_NODES = 200;

const CLASS_COMPONENT_TAG = 1;
const FUNCTION_COMPONENT_TAG = 0;
const FORWARD_REF_TAG = 11;
const MEMO_COMPONENT_TAG = 14;

export type ReactTreeNode = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly hasState: boolean;
  readonly hasHooks: boolean;
  readonly children: ReactTreeNode[];
};

export type ReactTreeOptions = {
  readonly rootIndex?: number;
  readonly depthLimit?: number;
  readonly maxNodes?: number;
};

export type ReactTreeResult = {
  readonly roots: ReactTreeNode[];
  readonly truncated: boolean;
  readonly rootCount: number;
};

const hasStateFor = (fiber: Fiber): boolean =>
  fiber.tag === CLASS_COMPONENT_TAG && fiber.memoizedState !== null;

const hasHooksFor = (fiber: Fiber): boolean => {
  if (fiber.memoizedState === null) return false;
  return (
    fiber.tag === FUNCTION_COMPONENT_TAG ||
    fiber.tag === FORWARD_REF_TAG ||
    fiber.tag === MEMO_COMPONENT_TAG
  );
};

type WalkState = {
  nodesEmitted: number;
  truncated: boolean;
};

const serializeNode = (
  fiber: Fiber,
  rootIndex: number,
  depth: number,
  depthLimit: number,
  state: WalkState,
  maxNodes: number,
): ReactTreeNode | undefined => {
  if (state.nodesEmitted >= maxNodes) {
    state.truncated = true;
    return undefined;
  }
  state.nodesEmitted += 1;

  const children: ReactTreeNode[] = [];
  if (depth < depthLimit) {
    let cursor: Fiber | null = fiber.child;
    while (cursor !== null) {
      const childNode = serializeNode(
        cursor,
        rootIndex,
        depth + 1,
        depthLimit,
        state,
        maxNodes,
      );
      if (childNode === undefined) break;
      children.push(childNode);
      cursor = cursor.sibling;
    }
  } else if (fiber.child !== null) {
    state.truncated = true;
  }

  const key = extractKey(fiber);
  const node: ReactTreeNode = {
    stableId: computeStableId(fiber, rootIndex),
    displayName: extractDisplayName(fiber),
    ...(key !== undefined ? { key } : {}),
    hasState: hasStateFor(fiber),
    hasHooks: hasHooksFor(fiber),
    children,
  };
  return node;
};

export const serializeTree = (
  doc: Document,
  options: ReactTreeOptions = {},
): ReactTreeResult => {
  const rootEls = findReactRoots(doc);
  const rootCount = rootEls.length;
  const depthLimit = options.depthLimit ?? DEFAULT_DEPTH_LIMIT;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  const selectedIndices: number[] =
    options.rootIndex === undefined
      ? rootEls.map((_, i) => i)
      : options.rootIndex >= 0 && options.rootIndex < rootCount
        ? [options.rootIndex]
        : [];

  const state: WalkState = { nodesEmitted: 0, truncated: false };
  const roots: ReactTreeNode[] = [];

  for (const i of selectedIndices) {
    const rootEl = rootEls[i];
    if (rootEl === undefined) continue;
    const rootFiber = getRootFiber(rootEl);
    if (rootFiber === undefined) continue;
    const node = serializeNode(rootFiber, i, 0, depthLimit, state, maxNodes);
    if (node !== undefined) roots.push(node);
    if (state.nodesEmitted >= maxNodes) break;
  }

  return { roots, truncated: state.truncated, rootCount };
};
