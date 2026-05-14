import type { Fiber } from './types.js';
import { REACT_CONTAINER_KEY_PREFIX, REACT_FIBER_KEY_PREFIX } from './types.js';

const HOST_ROOT_TAG = 3;

const readKeyValue = (el: Element, prefix: string): unknown => {
  let keys: string[];
  try {
    keys = Object.keys(el);
  } catch {
    return undefined;
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    if (!key.startsWith(prefix)) continue;
    try {
      return (el as unknown as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const climbToHostRoot = (fiber: Fiber): Fiber | undefined => {
  if (fiber.tag === HOST_ROOT_TAG) return fiber;
  let cursor: Fiber | null = fiber.return;
  while (cursor !== null) {
    if (cursor.tag === HOST_ROOT_TAG) return cursor;
    cursor = cursor.return;
  }
  return undefined;
};

export const getRootFiber = (rootEl: Element): Fiber | undefined => {
  const containerValue = readKeyValue(rootEl, REACT_CONTAINER_KEY_PREFIX);
  if (containerValue !== undefined && containerValue !== null) {
    const fiberRoot = containerValue as { current?: unknown };
    const current = fiberRoot.current;
    if (current !== null && current !== undefined) {
      return climbToHostRoot(current as Fiber);
    }
  }

  const fiberValue = readKeyValue(rootEl, REACT_FIBER_KEY_PREFIX);
  if (fiberValue !== undefined && fiberValue !== null) {
    return climbToHostRoot(fiberValue as Fiber);
  }

  return undefined;
};
