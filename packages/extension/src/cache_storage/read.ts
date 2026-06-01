/**
 * Async CacheStorage readers — the edge that performs caches.* I/O and composes
 * projectCacheEntry. The CacheStorage is injected (defaults to the page's global
 * `caches` at the call site) so these are unit-testable with a fake store.
 *
 * Wraps the browser CacheStorage API for the cache_list / cache_inspect /
 * cache_match MCP tools; orchestrators import these, never caches.* directly.
 */

import type {
  CacheListResult,
  CacheInspectResult,
  CacheMatchResult,
} from '@pwa-debug/shared';
import { projectCacheEntry } from './project.js';

export const readCacheList = async (
  store: CacheStorage | null,
): Promise<CacheListResult> => {
  if (store === null) return { supported: false, caches: [] };
  const names = await store.keys();
  const caches = await Promise.all(
    names.map(async (name) => {
      const cache = await store.open(name);
      const keys = await cache.keys();
      return { name, entryCount: keys.length };
    }),
  );
  return { supported: true, caches };
};

export const readCacheInspect = async (
  store: CacheStorage | null,
  name: string,
  limit: number,
  now: number,
): Promise<CacheInspectResult> => {
  if (store === null) {
    return { supported: false, found: false, name, entries: [], entryCount: 0, truncated: false };
  }
  if (!(await store.has(name))) {
    return { supported: true, found: false, name, entries: [], entryCount: 0, truncated: false };
  }
  const cache = await store.open(name);
  const keys = await cache.keys();
  const entryCount = keys.length;
  const entries = await Promise.all(
    keys.slice(0, limit).map(async (req) => {
      const res = await cache.match(req);
      return projectCacheEntry(
        {
          url: req.url,
          method: req.method,
          ...(res !== undefined
            ? { status: res.status, statusText: res.statusText, headers: res.headers }
            : {}),
        },
        now,
      );
    }),
  );
  return { supported: true, found: true, name, entries, entryCount, truncated: entryCount > limit };
};

export const readCacheMatch = async (
  store: CacheStorage | null,
  url: string,
  now: number,
): Promise<CacheMatchResult> => {
  if (store === null) {
    return { supported: false, url, matched: false, cacheName: null, entry: null };
  }
  const names = await store.keys();
  for (const name of names) {
    const cache = await store.open(name);
    const res = await cache.match(url);
    if (res !== undefined) {
      return {
        supported: true,
        url,
        matched: true,
        cacheName: name,
        entry: projectCacheEntry(
          { url, method: 'GET', status: res.status, statusText: res.statusText, headers: res.headers },
          now,
        ),
      };
    }
  }
  return { supported: true, url, matched: false, cacheName: null, entry: null };
};
