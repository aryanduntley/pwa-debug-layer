import {
  VUE_PARENT_COMPONENT_KEY,
  type ComponentInternalInstance,
} from './types.js';

/**
 * The ComponentInternalInstance that rendered a DOM node, via Vue's
 * `el.__vueParentComponent` back-pointer (parity with react getFiberForNode).
 * Returns undefined when the node was not rendered by Vue.
 */
export const getInstanceForNode = (
  el: Element,
): ComponentInternalInstance | undefined => {
  try {
    const v = (el as unknown as Record<string, unknown>)[
      VUE_PARENT_COMPONENT_KEY
    ];
    return v != null ? (v as ComponentInternalInstance) : undefined;
  } catch {
    return undefined;
  }
};
