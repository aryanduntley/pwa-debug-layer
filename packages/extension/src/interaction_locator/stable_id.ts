// stableId -> element resolution, dispatched by framework.
//
// react/vue stableIds address a component instance, so we resolve the instance
// and then descend to its host DOM element. solid's "stableId" is already a
// CSS-ish locator, so it routes through querySelector. svelte identity is a
// component .svelte FILE (not a single element), so it cannot resolve here —
// callers should use role/text/selector for svelte.

import { resolveStableId as resolveReactStableId } from '../react/resolve_stable_id.js';
import { findReactRoots } from '../react/find_react_roots.js';
import { walkFiber } from '../react/walk_fiber.js';
import type { Fiber } from '../react/types.js';
import { resolveStableId as resolveVueStableId } from '../vue/resolve_stable_id.js';
import { findVueRoots } from '../vue/find_vue_roots.js';
import type { ComponentInternalInstance } from '../vue/types.js';
import { bySelector } from './strategies.js';
import type { LocatorFramework } from './types.js';

const HOST_COMPONENT_TAG = 5;

const isElement = (node: unknown): node is Element =>
  node !== null &&
  typeof node === 'object' &&
  (node as { nodeType?: unknown }).nodeType === 1;

/**
 * First descendant host-node Element of a React fiber (the fiber itself when it
 * is already a host node). Walks the committed subtree via walkFiber.
 */
export const firstReactHostElement = (fiber: Fiber): Element | undefined => {
  if (isElement(fiber.stateNode)) return fiber.stateNode;
  let found: Element | undefined;
  walkFiber(fiber, (f) => {
    if (found !== undefined) return false;
    if (f.tag === HOST_COMPONENT_TAG && isElement(f.stateNode)) {
      found = f.stateNode;
      return false;
    }
    return;
  });
  return found;
};

/** Root DOM element a Vue component instance rendered, if any. */
const vueElementOf = (inst: ComponentInternalInstance | undefined): Element | undefined => {
  if (inst === undefined) return undefined;
  const el =
    (inst.subTree as { el?: unknown } | null)?.el ??
    (inst.vnode as { el?: unknown } | null)?.el;
  return isElement(el) ? el : undefined;
};

/** Resolve a framework stableId to 0 or 1 host element. */
export const resolveByStableId = (
  doc: Document,
  framework: LocatorFramework,
  stableId: string,
): Element[] => {
  switch (framework) {
    case 'react': {
      const fiber = resolveReactStableId(stableId, findReactRoots(doc));
      const el = fiber !== undefined ? firstReactHostElement(fiber) : undefined;
      return el !== undefined ? [el] : [];
    }
    case 'vue': {
      const el = vueElementOf(resolveVueStableId(stableId, findVueRoots(doc)));
      return el !== undefined ? [el] : [];
    }
    case 'solid':
      // Solid stableIds are CSS-ish locators produced by the solid finders.
      return bySelector(doc, stableId);
    case 'svelte':
    case 'dom':
    default:
      return [];
  }
};
