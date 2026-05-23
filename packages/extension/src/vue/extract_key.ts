import type { ComponentInternalInstance } from './types.js';

/**
 * The component's VNode key as a string, or undefined when unkeyed. Vue keys
 * may be string | number | symbol; numbers are stringified (so `:key="todo.id"`
 * round-trips), symbols are treated as unkeyed (not addressable by string id).
 */
export const extractKey = (
  instance: ComponentInternalInstance,
): string | undefined => {
  const key = instance.vnode?.key;
  if (key == null) return undefined;
  if (typeof key === 'string') return key.length > 0 ? key : undefined;
  if (typeof key === 'number') return String(key);
  return undefined;
};
