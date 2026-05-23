import { VUE_APP_KEY, type VueAppInstance } from './types.js';

/**
 * Read the Vue app instance off a mount-container element (`el.__vue_app__`).
 * Returns undefined when absent or when access throws (defensive against exotic
 * element proxies). Shared base for both component-tree traversal
 * (get_root_instance) and Pinia auto-discovery (stores/pinia/discover), so the
 * `__vue_app__` access lives in exactly one place.
 */
export const getVueApp = (rootEl: Element): VueAppInstance | undefined => {
  try {
    const v = (rootEl as unknown as Record<string, unknown>)[VUE_APP_KEY];
    return v != null ? (v as VueAppInstance) : undefined;
  } catch {
    return undefined;
  }
};
