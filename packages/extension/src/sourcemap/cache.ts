/**
 * LRU cache + fetcher for parsed source maps.
 *
 * - Cache key is the absolute map URL (or data: URL).
 * - On miss: fetches via the injected fetcher (defaults to globalThis.fetch),
 *   JSON-parses, validates via parseSourceMap.
 * - Parse/fetch failures are cached as `null` so repeated lookups don't re-fetch.
 *   This is intentional within a single page session; a future invalidation
 *   mechanism (ETag-aware) can replace this when we add capture-time annotation.
 *
 * Closure-based — no module state, factory returns the public surface.
 */
import { parseSourceMap, type ParsedMap } from './parse.js';

export type SourcemapCacheOptions = {
  readonly capacity?: number;
  readonly fetcher?: (url: string) => Promise<Response>;
};

export type SourcemapCache = {
  readonly get: (url: string) => Promise<ParsedMap | null>;
  readonly clear: () => void;
  readonly size: () => number;
};

const DEFAULT_CAPACITY = 64;

export const createSourcemapCache = (
  opts: SourcemapCacheOptions = {},
): SourcemapCache => {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const fetcher =
    opts.fetcher ??
    ((url: string): Promise<Response> => globalThis.fetch(url));
  // Map preserves insertion order; we delete + re-set on get to bump to MRU.
  const cache = new Map<string, ParsedMap | null>();

  const touch = (url: string, value: ParsedMap | null): void => {
    cache.delete(url);
    cache.set(url, value);
    while (cache.size > capacity) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const get = async (url: string): Promise<ParsedMap | null> => {
    if (cache.has(url)) {
      const cached = cache.get(url) ?? null;
      // Bump to MRU even on null hits.
      touch(url, cached);
      return cached;
    }
    let parsed: ParsedMap | null = null;
    try {
      const res = await fetcher(url);
      if (res.ok) {
        const json = (await res.json()) as unknown;
        parsed = parseSourceMap(json);
      }
    } catch {
      parsed = null;
    }
    touch(url, parsed);
    return parsed;
  };

  return Object.freeze({
    get,
    clear: () => cache.clear(),
    size: () => cache.size,
  });
};
