import type { ComponentInternalInstance, VueVNode } from './types.js';

const isVNode = (v: unknown): v is VueVNode =>
  typeof v === 'object' && v !== null && 'type' in v;

/**
 * Walk a VNode tree collecting the IMMEDIATE child component instances:
 *  - a component VNode carries `.component` → collect it and STOP descending
 *    (that child's own subTree is walked when the child is processed);
 *  - a host/fragment VNode → descend its `children` array (text/slot children
 *    that aren't VNodes are ignored).
 */
const walkVNode = (
  vnode: VueVNode | null,
  out: ComponentInternalInstance[],
): void => {
  if (vnode === null) return;
  if (vnode.component != null) {
    out.push(vnode.component);
    return;
  }
  const children = vnode.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isVNode(child)) walkVNode(child, out);
    }
  }
};

/**
 * Immediate child component instances of `instance`, in render order — derived
 * by walking its rendered `subTree` (Vue 3 instances have no `$children`). This
 * is the Vue analogue of fiber.child/sibling traversal; every other tree
 * operation (stable id, walk, resolve) is built on it.
 */
export const collectChildInstances = (
  instance: ComponentInternalInstance,
): ComponentInternalInstance[] => {
  const out: ComponentInternalInstance[] = [];
  walkVNode(instance.subTree, out);
  return out;
};
