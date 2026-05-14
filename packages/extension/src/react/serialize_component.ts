import type { Fiber } from './types.js';
import { computeStableId } from './compute_stable_id.js';
import { extractDisplayName } from './extract_display_name.js';
import { extractKey } from './extract_key.js';
import { extractHooks, type SerializedHook } from './extract_hooks.js';
import { serializeArgs } from '../captures/serialize.js';

const CLASS_COMPONENT_TAG = 1;
const FUNCTION_COMPONENT_TAG = 0;
const FORWARD_REF_TAG = 11;
const MEMO_COMPONENT_TAG = 14;

export type ReactComponentInfo = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly props?: unknown;
  readonly state?: unknown;
  readonly hooks?: SerializedHook[];
  readonly truncated?: boolean;
};

export type SerializeComponentOptions = {
  readonly includeProps?: boolean;
  readonly includeHooks?: boolean;
};

const serializeField = (
  value: unknown,
): { readonly value: unknown; readonly truncated: boolean } => {
  const r = serializeArgs([value]);
  return { value: r.serialized[0], truncated: r.truncated };
};

const isHooksFiber = (fiber: Fiber): boolean =>
  fiber.tag === FUNCTION_COMPONENT_TAG ||
  fiber.tag === FORWARD_REF_TAG ||
  fiber.tag === MEMO_COMPONENT_TAG;

export const serializeComponent = (
  fiber: Fiber,
  rootIndex = 0,
  options: SerializeComponentOptions = {},
): ReactComponentInfo => {
  const includeProps = options.includeProps !== false;
  const includeHooks = options.includeHooks !== false;

  const stableId = computeStableId(fiber, rootIndex);
  const displayName = extractDisplayName(fiber);
  const key = extractKey(fiber);

  let props: unknown;
  let propsTruncated = false;
  if (includeProps && fiber.memoizedProps !== null && fiber.memoizedProps !== undefined) {
    const ser = serializeField(fiber.memoizedProps);
    props = ser.value;
    propsTruncated = ser.truncated;
  }

  let state: unknown;
  let stateTruncated = false;
  if (
    fiber.tag === CLASS_COMPONENT_TAG &&
    fiber.memoizedState !== null &&
    fiber.memoizedState !== undefined
  ) {
    const ser = serializeField(fiber.memoizedState);
    state = ser.value;
    stateTruncated = ser.truncated;
  }

  let hooks: SerializedHook[] | undefined;
  let hooksTruncated = false;
  if (includeHooks && isHooksFiber(fiber)) {
    hooks = extractHooks(fiber);
    hooksTruncated = hooks.some((h) => h.truncated === true);
  }

  const truncated = propsTruncated || stateTruncated || hooksTruncated;

  return {
    stableId,
    displayName,
    ...(key !== undefined ? { key } : {}),
    ...(props !== undefined ? { props } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
};
