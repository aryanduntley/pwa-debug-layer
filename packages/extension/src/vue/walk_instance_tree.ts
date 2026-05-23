import type { ComponentInternalInstance } from './types.js';
import { collectChildInstances } from './collect_child_instances.js';

/** Visitor; return `false` to prune descent into this instance's children. */
export type InstanceVisitor = (
  instance: ComponentInternalInstance,
  depth: number,
) => void | boolean;

const visit = (
  instance: ComponentInternalInstance,
  depth: number,
  visitor: InstanceVisitor,
): void => {
  const result = visitor(instance, depth);
  if (result === false) return;
  for (const child of collectChildInstances(instance)) {
    visit(child, depth + 1, visitor);
  }
};

/**
 * Depth-first walk of the component-instance tree rooted at `root`, children
 * derived via collectChildInstances. Parity with react walkFiber; the Vue tree
 * contains only component instances (no host nodes).
 */
export const walkInstanceTree = (
  root: ComponentInternalInstance,
  visitor: InstanceVisitor,
): void => visit(root, 0, visitor);
