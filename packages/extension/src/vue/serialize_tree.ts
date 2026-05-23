/**
 * Page-world Vue component-tree serializer — parity with react/serialize_tree,
 * but over Vue's ComponentInternalInstance model: children come from
 * collectChildInstances (walking the rendered subTree) rather than React's
 * fiber.child/sibling links. Produces a depth- and node-capped nested tree of
 * stable ids + display names for the vue_tree MCP tool.
 *
 * Pure: reads the live instance tree via the M38 vue primitives; no DOM writes,
 * no chrome.*. The `doc` is only walked to find mount roots (findVueRoots).
 */
import { findVueRoots } from './find_vue_roots.js';
import { getRootInstance } from './get_root_instance.js';
import { collectChildInstances } from './collect_child_instances.js';
import { computeStableId } from './compute_stable_id.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';
import type { ComponentInternalInstance } from './types.js';

const DEFAULT_DEPTH_LIMIT = 8;
const DEFAULT_MAX_NODES = 200;

export type VueTreeNode = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  /** Component has at least one resolved prop. */
  readonly hasProps: boolean;
  /** Component exposes setup() bindings or options-API data. */
  readonly hasState: boolean;
  readonly children: VueTreeNode[];
};

export type VueTreeOptions = {
  readonly rootIndex?: number;
  readonly depthLimit?: number;
  readonly maxNodes?: number;
};

export type VueTreeResult = {
  readonly roots: VueTreeNode[];
  readonly truncated: boolean;
  readonly rootCount: number;
};

/** True when v is a non-null object with at least one own enumerable key. */
const hasEntries = (v: unknown): boolean =>
  v !== null && typeof v === 'object' && Object.keys(v as object).length > 0;

type WalkState = {
  nodesEmitted: number;
  truncated: boolean;
};

const serializeNode = (
  instance: ComponentInternalInstance,
  rootIndex: number,
  depth: number,
  depthLimit: number,
  state: WalkState,
  maxNodes: number,
): VueTreeNode | undefined => {
  if (state.nodesEmitted >= maxNodes) {
    state.truncated = true;
    return undefined;
  }
  state.nodesEmitted += 1;

  const childInstances = collectChildInstances(instance);
  const children: VueTreeNode[] = [];
  if (depth < depthLimit) {
    for (const child of childInstances) {
      const childNode = serializeNode(
        child,
        rootIndex,
        depth + 1,
        depthLimit,
        state,
        maxNodes,
      );
      if (childNode === undefined) break;
      children.push(childNode);
    }
  } else if (childInstances.length > 0) {
    state.truncated = true;
  }

  const key = extractKey(instance);
  return {
    stableId: computeStableId(instance, rootIndex),
    displayName: extractDisplayName(instance),
    ...(key !== undefined ? { key } : {}),
    hasProps: hasEntries(instance.props),
    hasState: hasEntries(instance.setupState) || hasEntries(instance.data),
    children,
  };
};

/**
 * Serialize the Vue component tree(s) on the document. Walks each Vue mount
 * root (or only options.rootIndex when given), capping depth (depthLimit) and
 * total nodes (maxNodes); `truncated` is set when either cap is hit. Returns the
 * nested roots plus the total Vue-root count for index disambiguation.
 */
export const serializeVueTree = (
  doc: Document,
  options: VueTreeOptions = {},
): VueTreeResult => {
  const rootEls = findVueRoots(doc);
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
  const roots: VueTreeNode[] = [];

  for (const i of selectedIndices) {
    const rootEl = rootEls[i];
    if (rootEl === undefined) continue;
    const rootInstance = getRootInstance(rootEl);
    if (rootInstance === undefined) continue;
    const node = serializeNode(rootInstance, i, 0, depthLimit, state, maxNodes);
    if (node !== undefined) roots.push(node);
    if (state.nodesEmitted >= maxNodes) break;
  }

  return { roots, truncated: state.truncated, rootCount };
};
