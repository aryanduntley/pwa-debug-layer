import { describe, it, expect } from 'vitest';
import { createSourcemapCache } from '../../src/sourcemap/cache.js';

const json = (obj: unknown): Response =>
  ({
    ok: true,
    json: async () => obj,
  }) as unknown as Response;

const fail = (status: number): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
  }) as unknown as Response;

describe('createSourcemapCache — fetch + parse', () => {
  it('fetches, parses, and returns the ParsedMap', async () => {
    let calls = 0;
    const cache = createSourcemapCache({
      fetcher: async () => {
        calls++;
        return json({ version: 3, sources: ['a.ts'], mappings: 'AAAA' });
      },
    });
    const r = await cache.get('https://x.com/a.map');
    expect(r).not.toBeNull();
    expect(r?.sources).toEqual(['a.ts']);
    expect(calls).toBe(1);
  });

  it('reuses the cached entry on subsequent gets (no second fetch)', async () => {
    let calls = 0;
    const cache = createSourcemapCache({
      fetcher: async () => {
        calls++;
        return json({ version: 3, sources: ['a.ts'], mappings: '' });
      },
    });
    await cache.get('https://x.com/a.map');
    await cache.get('https://x.com/a.map');
    await cache.get('https://x.com/a.map');
    expect(calls).toBe(1);
  });

  it('caches null on parse failure (no re-fetch)', async () => {
    let calls = 0;
    const cache = createSourcemapCache({
      fetcher: async () => {
        calls++;
        return json({ version: 2 }); // invalid: parser rejects
      },
    });
    const r1 = await cache.get('https://x.com/a.map');
    const r2 = await cache.get('https://x.com/a.map');
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(calls).toBe(1);
  });

  it('caches null on fetch failure (4xx)', async () => {
    const cache = createSourcemapCache({
      fetcher: async () => fail(404),
    });
    expect(await cache.get('https://x.com/a.map')).toBeNull();
  });

  it('caches null on fetcher throw', async () => {
    const cache = createSourcemapCache({
      fetcher: async () => {
        throw new Error('network down');
      },
    });
    expect(await cache.get('https://x.com/a.map')).toBeNull();
  });
});

describe('createSourcemapCache — LRU eviction', () => {
  it('evicts the oldest entry when capacity exceeded', async () => {
    let calls = 0;
    const cache = createSourcemapCache({
      capacity: 2,
      fetcher: async () => {
        calls++;
        return json({ version: 3, sources: ['x'], mappings: '' });
      },
    });
    await cache.get('a');
    await cache.get('b');
    expect(cache.size()).toBe(2);
    await cache.get('c'); // evicts 'a'
    expect(cache.size()).toBe(2);
    expect(calls).toBe(3);
    await cache.get('a'); // re-fetch — 'a' was evicted
    expect(calls).toBe(4);
  });

  it('reaccess bumps an entry to MRU', async () => {
    let calls = 0;
    const cache = createSourcemapCache({
      capacity: 2,
      fetcher: async () => {
        calls++;
        return json({ version: 3, sources: ['x'], mappings: '' });
      },
    });
    await cache.get('a');
    await cache.get('b');
    await cache.get('a'); // a becomes MRU; b is LRU
    await cache.get('c'); // evicts 'b'
    expect(calls).toBe(3);
    await cache.get('a'); // still cached
    expect(calls).toBe(3);
    await cache.get('b'); // was evicted — re-fetch
    expect(calls).toBe(4);
  });
});

describe('createSourcemapCache — clear', () => {
  it('drops all entries', async () => {
    let calls = 0;
    const cache = createSourcemapCache({
      fetcher: async () => {
        calls++;
        return json({ version: 3, sources: ['x'], mappings: '' });
      },
    });
    await cache.get('a');
    cache.clear();
    expect(cache.size()).toBe(0);
    await cache.get('a');
    expect(calls).toBe(2);
  });
});
