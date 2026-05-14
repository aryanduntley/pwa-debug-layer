import type { Fiber } from './types.js';
import { serializeArgs } from '../captures/serialize.js';

export type HookType =
  | 'state'
  | 'reducer'
  | 'memo'
  | 'effect'
  | 'ref'
  | 'context'
  | 'custom';

export type SerializedHook = {
  readonly type: HookType;
  readonly index: number;
  readonly value?: unknown;
  readonly deps?: unknown;
  readonly truncated?: boolean;
};

type HookNode = {
  readonly memoizedState: unknown;
  readonly queue: unknown;
  readonly next: HookNode | null;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

const isEffectShape = (v: unknown): boolean => {
  if (!isObject(v)) return false;
  return (
    'tag' in v &&
    'create' in v &&
    'destroy' in v &&
    'deps' in v
  );
};

const isMemoTuple = (v: unknown): boolean => {
  if (!Array.isArray(v)) return false;
  if (v.length !== 2) return false;
  return Array.isArray(v[1]) || v[1] === null;
};

const isRefShape = (v: unknown): boolean => {
  if (!isObject(v)) return false;
  if (!('current' in v)) return false;
  for (const k of Object.keys(v)) {
    if (k !== 'current') return false;
  }
  return true;
};

const isHookNode = (v: unknown): v is HookNode =>
  isObject(v) && 'memoizedState' in v && 'next' in v;

type Classified = {
  readonly type: HookType;
  readonly value?: unknown;
  readonly hasValue: boolean;
  readonly deps?: unknown;
  readonly hasDeps: boolean;
};

const classify = (node: HookNode): Classified => {
  if (node.queue !== null && node.queue !== undefined) {
    return { type: 'state', value: node.memoizedState, hasValue: true, hasDeps: false };
  }
  if (isEffectShape(node.memoizedState)) {
    const m = node.memoizedState as Record<string, unknown>;
    return { type: 'effect', hasValue: false, deps: m['deps'], hasDeps: true };
  }
  if (isMemoTuple(node.memoizedState)) {
    const tuple = node.memoizedState as [unknown, unknown];
    return {
      type: 'memo',
      value: tuple[0],
      hasValue: true,
      deps: tuple[1],
      hasDeps: true,
    };
  }
  if (isRefShape(node.memoizedState)) {
    const r = node.memoizedState as { current: unknown };
    return { type: 'ref', value: r.current, hasValue: true, hasDeps: false };
  }
  return { type: 'custom', value: node.memoizedState, hasValue: true, hasDeps: false };
};

const isTruncatedTag = (v: unknown): boolean =>
  isObject(v) && v['__type'] === 'Truncated';

export const extractHooks = (fiber: Fiber): SerializedHook[] => {
  const head = fiber.memoizedState;
  if (!isHookNode(head)) return [];

  const result: SerializedHook[] = [];
  let cursor: HookNode | null = head;
  let index = 0;

  while (cursor !== null) {
    const c = classify(cursor);
    const payload: unknown[] = [];
    if (c.hasValue) payload.push(c.value);
    if (c.hasDeps) payload.push(c.deps);

    const ser = payload.length > 0 ? serializeArgs(payload) : { serialized: [], truncated: false };

    const entry: {
      type: HookType;
      index: number;
      value?: unknown;
      deps?: unknown;
      truncated?: boolean;
    } = { type: c.type, index };

    let i = 0;
    if (c.hasValue) {
      entry.value = ser.serialized[i];
      i += 1;
    }
    if (c.hasDeps) {
      entry.deps = ser.serialized[i];
    }
    const anyTruncated =
      ser.truncated ||
      (c.hasValue && isTruncatedTag(entry.value)) ||
      (c.hasDeps && isTruncatedTag(entry.deps));
    if (anyTruncated) entry.truncated = true;

    result.push(entry);

    const next: unknown = cursor.next;
    cursor = isHookNode(next) ? next : null;
    index += 1;
  }

  return result;
};
