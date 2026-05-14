import type { Fiber } from './types.js';

export const siblingPosition = (fiber: Fiber): number => {
  const parent = fiber.return;
  if (parent === null) return -1;

  let index = 0;
  let cursor = parent.child;
  while (cursor !== null) {
    if (cursor === fiber) return index;
    cursor = cursor.sibling;
    index += 1;
  }
  return -1;
};
