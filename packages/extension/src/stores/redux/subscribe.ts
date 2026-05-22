/**
 * Page-world Redux subscription manager. Installs a single store.subscribe
 * callback that, on each store change, computes a shallow diff against the
 * prior path-narrowed snapshot and (when something changed) emits a
 * StoreChangeCapturedEvent through the captures pipeline.
 *
 * No coalescing — rapid dispatch bursts produce one emit per change. The
 * page-world buffer overflow + host disk-spill handle volume. Path-narrowing
 * filters at the source so an unrelated state slice doesn't trigger emits.
 *
 * The manager is closure-based — install() returns a Disposer; calling the
 * disposer tears down the store.subscribe handler. setReduxShim-style
 * singleton handling lives in the orchestrator (page_dispatch.ts), not here.
 */
import type {
  StoreChangeCapturedEvent,
  StoreChangeDiff,
} from '@pwa-debug/shared';
import type { Disposer, FrameMeta } from '../../captures/capture_console.js';
import type { StoreHandle } from '../contract.js';
import { getValueAtPath } from './path_get.js';
import { serializeStoreValue } from './serialize.js';
import { safeRandomId } from '../../ids/safe_random_id.js';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Pure shallow diff at the top level of two values. Returns undefined when
 * the values are === or when both are non-objects of the same value. Otherwise
 * names the top-level keys that were added/changed/removed between prev and
 * next. For non-object values, the diff treats the whole thing as a single
 * 'value' field that's either changed or unchanged.
 */
export const computeShallowDiff = (
  prev: unknown,
  next: unknown,
): StoreChangeDiff | undefined => {
  if (prev === next) return undefined;
  if (!isPlainObject(prev) || !isPlainObject(next)) {
    return { added: [], changed: ['value'], removed: [] };
  }
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  const prevSet = new Set(prevKeys);
  const nextSet = new Set(nextKeys);
  for (const k of nextKeys) {
    if (!prevSet.has(k)) {
      added.push(k);
    } else if (prev[k] !== next[k]) {
      changed.push(k);
    }
  }
  for (const k of prevKeys) {
    if (!nextSet.has(k)) removed.push(k);
  }
  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    return undefined;
  }
  return { added, changed, removed };
};

export type StoreSubscriptionOptions = {
  readonly store: StoreHandle;
  readonly emit: (event: StoreChangeCapturedEvent) => void;
  readonly frame: FrameMeta;
  readonly path?: string;
  readonly storeId?: string;
  /** Detecting adapter's framework tag; stamped onto each emitted event so
   *  tail entries are self-describing. */
  readonly framework?: string;
  readonly now?: () => number;
};

/**
 * Install a store.subscribe handler. Returns a Disposer that tears it down.
 * Each store update reads the current state, narrows by `path` (if provided),
 * diffs against the previous narrowed snapshot, and emits a
 * StoreChangeCapturedEvent when the diff is non-empty.
 */
export const installStoreSubscription = (
  opts: StoreSubscriptionOptions,
): Disposer => {
  const now = opts.now ?? Date.now;
  const storeId = opts.storeId ?? safeRandomId();
  // Seed prev with the initial state so the first real change emits a diff.
  let prev: unknown;
  const initialPath = getValueAtPath(opts.store.getState(), opts.path);
  prev = initialPath.ok ? initialPath.value : undefined;

  const listener = (): void => {
    const state = opts.store.getState();
    const picked = getValueAtPath(state, opts.path);
    if (!picked.ok) return; // path went malformed; drop silently (settings.set should reject)
    const next = picked.value;
    const diff = computeShallowDiff(prev, next);
    if (diff === undefined) return;
    const serialized = serializeStoreValue(next);
    const event: StoreChangeCapturedEvent = {
      kind: 'store_change',
      ts: now(),
      frameUrl: opts.frame.frameUrl,
      frameKey: opts.frame.frameKey,
      storeId,
      diff,
      snapshot: serialized.value,
      ...(opts.framework !== undefined ? { framework: opts.framework } : {}),
      ...(opts.path !== undefined ? { path: opts.path } : {}),
      ...(serialized.truncated ? { truncated: true } : {}),
    };
    opts.emit(event);
    prev = next;
  };

  const unsubscribe = opts.store.subscribe(listener);
  return () => {
    unsubscribe();
  };
};
