/**
 * Pure projection of a cached request/response pair into a CacheEntryRecord.
 * No caches.* I/O — the readers (read.ts) perform the async reads and hand the
 * already-extracted fields here, keeping this unit-testable with plain fakes.
 */

import type { CacheEntryRecord } from '@pwa-debug/shared';

/** Minimal structural view of a Headers object (Response.headers satisfies it). */
type HeadersLike = { readonly get: (name: string) => string | null };

export type CacheEntryInput = {
  readonly url: string;
  readonly method: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: HeadersLike | null;
};

const parseContentLength = (raw: string | null): number | null => {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const computeAgeSeconds = (dateHeader: string | null, now: number): number | null => {
  if (dateHeader === null) return null;
  const parsed = Date.parse(dateHeader);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((now - parsed) / 1000));
};

export const projectCacheEntry = (
  input: CacheEntryInput,
  now: number,
): CacheEntryRecord => {
  const headers = input.headers ?? null;
  const get = (name: string): string | null =>
    headers === null ? null : headers.get(name);
  const dateHeader = get('date');
  return {
    url: input.url,
    method: input.method,
    status: input.status ?? null,
    ...(input.statusText !== undefined && input.statusText.length > 0
      ? { statusText: input.statusText }
      : {}),
    contentType: get('content-type'),
    contentLength: parseContentLength(get('content-length')),
    dateHeader,
    ageSeconds: computeAgeSeconds(dateHeader, now),
    cacheControl: get('cache-control'),
  };
};
