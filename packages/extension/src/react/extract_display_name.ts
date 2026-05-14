import type { Fiber } from './types.js';

const HOST_ROOT_TAG = 3;
const HOST_COMPONENT_TAG = 5;
const HOST_TEXT_TAG = 6;
const FRAGMENT_TAG = 7;

const nameFromType = (type: unknown): string | undefined => {
  if (type === null || type === undefined) return undefined;

  if (typeof type === 'object' || typeof type === 'function') {
    const obj = type as { displayName?: unknown; name?: unknown };
    if (typeof obj.displayName === 'string' && obj.displayName.length > 0) {
      return obj.displayName;
    }
    if (typeof obj.name === 'string' && obj.name.length > 0) {
      return obj.name;
    }
  }
  return undefined;
};

const unwrapMemo = (type: unknown): unknown => {
  if (type !== null && typeof type === 'object' && 'type' in type) {
    return (type as { type: unknown }).type;
  }
  return undefined;
};

const unwrapForwardRef = (type: unknown): unknown => {
  if (type !== null && typeof type === 'object' && 'render' in type) {
    return (type as { render: unknown }).render;
  }
  return undefined;
};

const isMemoWrapper = (type: unknown): boolean =>
  type !== null && typeof type === 'object' && 'type' in type && !('render' in type);

const isForwardRefWrapper = (type: unknown): boolean =>
  type !== null && typeof type === 'object' && 'render' in type;

export const extractDisplayName = (fiber: Fiber): string => {
  switch (fiber.tag) {
    case HOST_ROOT_TAG:
      return 'HostRoot';
    case HOST_COMPONENT_TAG:
      return typeof fiber.type === 'string' ? fiber.type : 'HostComponent';
    case HOST_TEXT_TAG:
      return 'Text';
    case FRAGMENT_TAG:
      return 'Fragment';
  }

  const direct = nameFromType(fiber.type);
  if (direct !== undefined) return direct;

  if (isForwardRefWrapper(fiber.type)) {
    const inner = unwrapForwardRef(fiber.type);
    const innerName = nameFromType(inner) ?? 'Anonymous';
    return `ForwardRef(${innerName})`;
  }

  if (isMemoWrapper(fiber.type)) {
    const inner = unwrapMemo(fiber.type);
    if (isForwardRefWrapper(inner)) {
      const innerInner = unwrapForwardRef(inner);
      const innerName = nameFromType(innerInner) ?? 'Anonymous';
      return `Memo(ForwardRef(${innerName}))`;
    }
    const innerName = nameFromType(inner) ?? 'Anonymous';
    return `Memo(${innerName})`;
  }

  return 'Anonymous';
};
