import { describe, it, expect } from 'vitest';
import {
  gatherUpdateInputs,
  type GatherDeps,
} from '../../src/update_analysis/gather.js';
import type {
  SwStatusSnapshot,
  CacheListResult,
  CacheInspectResult,
  CacheEntryRecord,
} from '@pwa-debug/shared';

const sw: SwStatusSnapshot = {
  supported: true,
  controller: null,
  registrations: [],
  hasWaitingUpdate: false,
};

const cacheEntry = (url: string): CacheEntryRecord => ({
  url,
  method: 'GET',
  status: 200,
  contentType: 'text/html',
  contentLength: null,
  dateHeader: null,
  ageSeconds: 10,
  cacheControl: null,
});

const deps = (
  list: CacheListResult,
  inspect: (name: string) => CacheInspectResult,
): GatherDeps => ({
  readSw: () => Promise.resolve(sw),
  readCacheList: () => Promise.resolve(list),
  readCacheInspect: (name) => Promise.resolve(inspect(name)),
});

const inspectResult = (name: string, entries: CacheEntryRecord[]): CacheInspectResult => ({
  supported: true,
  found: true,
  name,
  entries,
  entryCount: entries.length,
  truncated: false,
});

describe('gatherUpdateInputs', () => {
  it('returns the SW snapshot with no entries when caches.* is unsupported', async () => {
    const r = await gatherUpdateInputs(
      deps({ supported: false, caches: [] }, () => inspectResult('x', [])),
    );
    expect(r.sw).toBe(sw);
    expect(r.cacheEntries).toEqual([]);
  });

  it('flattens entries across all caches, tagging each with its cacheName', async () => {
    const list: CacheListResult = {
      supported: true,
      caches: [
        { name: 'pages', entryCount: 1 },
        { name: 'assets', entryCount: 1 },
      ],
    };
    const r = await gatherUpdateInputs(
      deps(list, (name) =>
        inspectResult(name, [cacheEntry(`https://x/${name}/file`)]),
      ),
    );
    expect(r.cacheEntries).toHaveLength(2);
    expect(r.cacheEntries.map((e) => e.cacheName).sort()).toEqual(['assets', 'pages']);
    expect(r.cacheEntries.find((e) => e.cacheName === 'pages')!.url).toBe(
      'https://x/pages/file',
    );
  });

  it('forwards the per-cache limit to readCacheInspect', async () => {
    const seen: number[] = [];
    const customDeps: GatherDeps = {
      readSw: () => Promise.resolve(sw),
      readCacheList: () =>
        Promise.resolve({ supported: true, caches: [{ name: 'c', entryCount: 0 }] }),
      readCacheInspect: (name, limit) => {
        seen.push(limit);
        return Promise.resolve(inspectResult(name, []));
      },
    };
    await gatherUpdateInputs(customDeps, 7);
    expect(seen).toEqual([7]);
  });
});
