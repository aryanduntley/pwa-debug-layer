import { type ComponentInternalInstance } from './types.js';
import { getVueApp } from './get_vue_app.js';

/**
 * Resolve the root component instance from a Vue mount-container element
 * (`el.__vue_app__._instance`). Unlike React's HostRoot wrapper, this IS the
 * root component (e.g. App), so it is the node addressed by the first child
 * segment of a stable id. Returns undefined when absent or malformed.
 */
export const getRootInstance = (
  rootEl: Element,
): ComponentInternalInstance | undefined => {
  const inst = getVueApp(rootEl)?._instance;
  return inst != null ? inst : undefined;
};
