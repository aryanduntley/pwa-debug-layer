import type { Fiber } from './types.js';

export const extractKey = (fiber: Fiber): string | undefined => {
  const key = fiber.key;
  if (key === null) return undefined;
  if (typeof key !== 'string') return undefined;
  if (key.length === 0) return undefined;
  return key;
};
