/**
 * Wire types for the `pwa_snapshot` tool — ONE capped record of the debugged
 * PWA's runtime state at a moment in time, for deterministic bug-repro context.
 * Pure composition of already-exposed reads: service-worker status, store
 * state, web storage, IndexedDB structure, and CacheStorage names. No new
 * capture surface.
 *
 * Pure type module (no runtime). The page-world gather lives in the extension
 * `runtime_snapshot` module; the host `pwa_snapshot` tool validates against
 * these shapes and returns the blob for the AI to reason over / hand off.
 */

import type { StorageGetResult } from './storage.js';
import type { IdbListResult } from './storage.js';
import type { CacheListResult } from './cache_storage.js';
import type { SwStatusSnapshot } from './sw_status.js';

/**
 * The detected store's full state, framework-tagged and value-capped; null when
 * no store was discovered (no react-redux/pinia/jotai/zustand handle).
 */
export type RuntimeStoreState = {
  readonly framework: string;
  readonly state: unknown;
  /** True when the serialized state hit the shared 16KB cap. */
  readonly truncated?: boolean;
} | null;

/** Both web-storage areas captured together. */
export type RuntimeWebStorage = {
  readonly local: StorageGetResult;
  readonly session: StorageGetResult;
};

/** One full runtime-state snapshot returned by `pwa_snapshot`. */
export type RuntimeSnapshot = {
  readonly url: string;
  readonly title: string;
  /** page-world Date.now() at capture, in epoch ms. */
  readonly capturedAt: number;
  readonly sw: SwStatusSnapshot;
  readonly store: RuntimeStoreState;
  readonly webStorage: RuntimeWebStorage;
  /** IndexedDB STRUCTURE (db/store schema) — records are not included here. */
  readonly idb: IdbListResult;
  /** CacheStorage names + entry counts (entries are not included here). */
  readonly cacheNames: CacheListResult;
};
