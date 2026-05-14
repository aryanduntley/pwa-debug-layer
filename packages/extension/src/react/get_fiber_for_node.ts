import type { Fiber } from './types.js';
import { REACT_FIBER_KEY_PREFIX } from './types.js';

export const getFiberForNode = (el: Element): Fiber | undefined => {
  let keys: string[];
  try {
    keys = Object.keys(el);
  } catch {
    return undefined;
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    if (!key.startsWith(REACT_FIBER_KEY_PREFIX)) continue;
    try {
      const value = (el as unknown as Record<string, unknown>)[key];
      if (value == null) return undefined;
      return value as Fiber;
    } catch {
      return undefined;
    }
  }
  return undefined;
};
