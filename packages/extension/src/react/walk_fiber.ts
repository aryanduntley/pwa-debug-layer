import type { Fiber } from './types.js';

export type FiberVisitor = (fiber: Fiber, depth: number) => void | boolean;

const visit = (fiber: Fiber, depth: number, visitor: FiberVisitor): void => {
  const result = visitor(fiber, depth);
  if (result !== false && fiber.child !== null) visit(fiber.child, depth + 1, visitor);
  if (fiber.sibling !== null) visit(fiber.sibling, depth, visitor);
};

export const walkFiber = (fiber: Fiber, visitor: FiberVisitor): void => {
  const result = visitor(fiber, 0);
  if (result === false) return;
  if (fiber.child !== null) visit(fiber.child, 1, visitor);
};
