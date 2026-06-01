import { describe, it, expect } from 'vitest';
import { projectCacheEntry } from '../../src/cache_storage/project.js';
import {
  readCacheList,
  readCacheInspect,
  readCacheMatch,
} from '../../src/cache_storage/read.js';

const headers = (h: Record<string, string>) => ({
  get: (k: string): string | null => h[k.toLowerCase()] ?? null,
});

const res = (status: number, h: Record<string, string>) => ({
  status,
  statusText: 'OK',
  headers: headers(h),
});

const req = (url: string, method = 'GET') => ({ url, method });

type Entry = { req: ReturnType<typeof req>; res: ReturnType<typeof res> };

const cache = (entries: Entry[]) => ({
  keys: async () => entries.map((e) => e.req),
  match: async (key: unknown) => {
    const url = typeof key === 'string' ? key : (key as { url: string }).url;
    return entries.find((e) => e.req.url === url)?.res;
  },
});

const store = (caches: Record<string, ReturnType<typeof cache>>) =>
  ({
    keys: async () => Object.keys(caches),
    has: async (name: string) => name in caches,
    open: async (name: string) => caches[name],
  }) as unknown as CacheStorage;

describe('projectCacheEntry', () => {
  it('projects headers and computes ageSeconds from the Date header', () => {
    const e = projectCacheEntry(
      {
        url: 'https://app.example/app.js',
        method: 'GET',
        status: 200,
        statusText: 'OK',
        headers: headers({
          'content-type': 'application/javascript',
          'content-length': '1234',
          date: 'Thu, 01 Jan 1970 00:00:00 GMT',
          'cache-control': 'max-age=3600',
        }),
      },
      5000,
    );
    expect(e).toEqual({
      url: 'https://app.example/app.js',
      method: 'GET',
      status: 200,
      statusText: 'OK',
      contentType: 'application/javascript',
      contentLength: 1234,
      dateHeader: 'Thu, 01 Jan 1970 00:00:00 GMT',
      ageSeconds: 5,
      cacheControl: 'max-age=3600',
    });
  });

  it('nulls out missing fields and no-response status', () => {
    const e = projectCacheEntry({ url: 'https://app.example/x', method: 'GET' }, 0);
    expect(e).toMatchObject({
      status: null,
      contentType: null,
      contentLength: null,
      dateHeader: null,
      ageSeconds: null,
      cacheControl: null,
    });
    expect('statusText' in e).toBe(false);
  });
});

describe('readCacheList', () => {
  it('returns supported:false for a null store', async () => {
    expect(await readCacheList(null)).toEqual({ supported: false, caches: [] });
  });

  it('lists cache names with entry counts', async () => {
    const s = store({
      'static-v1': cache([
        { req: req('https://app.example/a.js'), res: res(200, {}) },
        { req: req('https://app.example/b.js'), res: res(200, {}) },
      ]),
      'api-v1': cache([{ req: req('https://app.example/api/user'), res: res(200, {}) }]),
    });
    expect(await readCacheList(s)).toEqual({
      supported: true,
      caches: [
        { name: 'static-v1', entryCount: 2 },
        { name: 'api-v1', entryCount: 1 },
      ],
    });
  });
});

describe('readCacheInspect', () => {
  it('returns found:false for an unknown cache', async () => {
    const s = store({ 'static-v1': cache([]) });
    const r = await readCacheInspect(s, 'missing', 100, 0);
    expect(r).toMatchObject({ supported: true, found: false, entries: [] });
  });

  it('projects entries and flags truncation when over the limit', async () => {
    const s = store({
      'static-v1': cache([
        { req: req('https://app.example/a.js'), res: res(200, { 'content-type': 'application/javascript' }) },
        { req: req('https://app.example/b.js'), res: res(200, {}) },
        { req: req('https://app.example/c.js'), res: res(200, {}) },
      ]),
    });
    const r = await readCacheInspect(s, 'static-v1', 2, 0);
    expect(r.found).toBe(true);
    expect(r.entryCount).toBe(3);
    expect(r.entries).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.entries[0]).toMatchObject({
      url: 'https://app.example/a.js',
      contentType: 'application/javascript',
      status: 200,
    });
  });
});

describe('readCacheMatch', () => {
  it('finds the first cache serving a URL', async () => {
    const s = store({
      'static-v1': cache([{ req: req('https://app.example/a.js'), res: res(200, {}) }]),
      'api-v1': cache([{ req: req('https://app.example/api/user'), res: res(200, {}) }]),
    });
    const r = await readCacheMatch(s, 'https://app.example/api/user', 0);
    expect(r).toMatchObject({ matched: true, cacheName: 'api-v1' });
    expect(r.entry?.url).toBe('https://app.example/api/user');
  });

  it('reports no match when nothing serves the URL', async () => {
    const s = store({ 'static-v1': cache([]) });
    const r = await readCacheMatch(s, 'https://app.example/nope', 0);
    expect(r).toMatchObject({ matched: false, cacheName: null, entry: null });
  });

  it('returns supported:false for a null store', async () => {
    expect(await readCacheMatch(null, 'https://x/', 0)).toMatchObject({
      supported: false,
      matched: false,
    });
  });
});
