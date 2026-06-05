/**
 * Page-world gather for pwa_snapshot: capture ONE runtime-state record by
 * composing the existing page-world readers (service worker, store, web storage,
 * IndexedDB structure, CacheStorage names) plus page meta. Pure composition over
 * injected readers — no navigator/caches/indexedDB globals here — so it is
 * unit-testable with plain fakes. Adds no new capture surface.
 */

import type {
  SwStatusSnapshot,
  StorageGetResult,
  IdbListResult,
  CacheListResult,
  RuntimeStoreState,
  RuntimeSnapshot,
} from '@pwa-debug/shared';

/** Injected readers + meta — the live page-world readers at the call site. */
export type SnapshotDeps = {
  readMeta: () => { url: string; title: string; capturedAt: number };
  readSw: () => Promise<SwStatusSnapshot>;
  /** Detected store's framework-tagged, value-capped state, or null if none. */
  readStore: () => RuntimeStoreState;
  readWebStorage: (area: 'local' | 'session') => StorageGetResult;
  readIdbList: () => Promise<IdbListResult>;
  readCacheList: () => Promise<CacheListResult>;
};

/**
 * Assemble a RuntimeSnapshot. The async reads (SW, IDB, caches) run
 * concurrently; the synchronous reads (store, web storage, meta) are read
 * inline. Each sub-read already self-caps, so the composed blob stays bounded.
 */
export const gatherRuntimeSnapshot = async (
  deps: SnapshotDeps,
): Promise<RuntimeSnapshot> => {
  const meta = deps.readMeta();
  const [sw, idb, cacheNames] = await Promise.all([
    deps.readSw(),
    deps.readIdbList(),
    deps.readCacheList(),
  ]);
  return {
    url: meta.url,
    title: meta.title,
    capturedAt: meta.capturedAt,
    sw,
    store: deps.readStore(),
    webStorage: {
      local: deps.readWebStorage('local'),
      session: deps.readWebStorage('session'),
    },
    idb,
    cacheNames,
  };
};
