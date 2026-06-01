/**
 * Wire types for the CacheStorage inspection tools (cache_list / cache_inspect /
 * cache_match) — a projection of the debugged PWA's caches.* contents. These
 * answer the #1 PWA pain (stale cache): what's cached, how old is it, and which
 * cache would serve a given URL.
 *
 * Pure type module (no runtime). Projection lives in the extension
 * cache_storage module; the host tools validate against these shapes.
 */

/** One CacheStorage entry projected to wire. */
export type CacheEntryRecord = {
  readonly url: string;
  readonly method: string;
  /** Matched response status; null when no response matched the key. */
  readonly status: number | null;
  readonly statusText?: string;
  readonly contentType: string | null;
  /** From the content-length header, when present (bodies are not read). */
  readonly contentLength: number | null;
  /** Raw Date response header, when present. */
  readonly dateHeader: string | null;
  /** now − Date header, in seconds — "how stale is this entry". */
  readonly ageSeconds: number | null;
  readonly cacheControl: string | null;
};

/** One cache in CacheStorage. */
export type CacheListItem = {
  readonly name: string;
  readonly entryCount: number;
};

export type CacheListResult = {
  /** False when caches.* is unavailable (insecure context / unsupported). */
  readonly supported: boolean;
  readonly caches: readonly CacheListItem[];
};

export type CacheInspectResult = {
  readonly supported: boolean;
  /** Whether a cache with the requested name exists. */
  readonly found: boolean;
  readonly name: string;
  readonly entries: readonly CacheEntryRecord[];
  readonly entryCount: number;
  /** True when entryCount exceeded the limit and entries were capped. */
  readonly truncated: boolean;
};

export type CacheMatchResult = {
  readonly supported: boolean;
  readonly url: string;
  readonly matched: boolean;
  /** The first cache (in CacheStorage order) that serves the URL, or null. */
  readonly cacheName: string | null;
  readonly entry: CacheEntryRecord | null;
};
