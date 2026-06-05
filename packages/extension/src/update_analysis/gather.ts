/**
 * Page-world gather for pwa_update_analyze: collects the two page-side inputs
 * the host analyzer needs — a service-worker snapshot and a capped, cross-cache
 * list of CacheStorage entries — in one pass. Pure composition over the existing
 * sw_status + cache_storage readers; the readers are injected so this is
 * unit-testable with plain fakes (no navigator/caches globals here).
 *
 * The host pulls recent network failures from its own ring buffer and runs the
 * analysis — this module adds no new capture surface.
 */

import type {
  SwStatusSnapshot,
  CacheListResult,
  CacheInspectResult,
  UpdateGatherResult,
} from '@pwa-debug/shared';

/** Default per-cache entry cap so a huge cache cannot blow the gather payload. */
export const DEFAULT_GATHER_PER_CACHE_LIMIT = 100;

/** Injected readers — the live page-world readers at the call site, fakes in tests. */
export type GatherDeps = {
  readSw: () => Promise<SwStatusSnapshot>;
  readCacheList: () => Promise<CacheListResult>;
  readCacheInspect: (name: string, limit: number) => Promise<CacheInspectResult>;
};

/**
 * Gather the SW snapshot + every cache's entries (each tagged with its
 * cacheName, capped per cache). caches.* unavailable ⇒ entries omitted; the SW
 * snapshot is always included so the waiting-update detection still works.
 */
export const gatherUpdateInputs = async (
  deps: GatherDeps,
  perCacheLimit: number = DEFAULT_GATHER_PER_CACHE_LIMIT,
): Promise<UpdateGatherResult> => {
  const sw = await deps.readSw();
  const list = await deps.readCacheList();
  if (!list.supported) return { sw, cacheEntries: [] };
  const perCache = await Promise.all(
    list.caches.map(async (c) => {
      const inspected = await deps.readCacheInspect(c.name, perCacheLimit);
      return inspected.entries.map((e) => ({ ...e, cacheName: c.name }));
    }),
  );
  return { sw, cacheEntries: perCache.flat() };
};
