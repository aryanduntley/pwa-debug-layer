/**
 * Web-storage (localStorage / sessionStorage) reader for the storage_get tool.
 *
 * The Storage object is injected (the page passes window.localStorage /
 * window.sessionStorage at the call site) so this is unit-testable with a plain
 * fake. Synchronous DOM Storage API — no async. Values are length-capped and the
 * entry list is count-capped so a large store cannot blow the wire payload.
 */

import type { StorageArea, StorageEntry, StorageGetResult } from '@pwa-debug/shared';

/** Per-value character cap — long blobs (JWTs, serialized state) are truncated. */
export const STORAGE_VALUE_CAP = 8192;

/** Minimal structural view of a Storage object (Web Storage API subset used). */
export type StorageLike = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
};

const capValue = (raw: string): { value: string; truncated: boolean } =>
  raw.length <= STORAGE_VALUE_CAP
    ? { value: raw, truncated: false }
    : { value: raw.slice(0, STORAGE_VALUE_CAP), truncated: true };

/**
 * Snapshot a Storage area into a capped StorageGetResult. `storage === null`
 * (area unavailable/blocked) yields supported:false. Keys are read in the
 * area's native index order; `limit` caps how many entries are returned, and
 * entryCount always reports the true total so the caller sees what was dropped.
 */
export const readWebStorage = (
  storage: StorageLike | null,
  area: StorageArea,
  limit: number,
): StorageGetResult => {
  if (storage === null) {
    return { supported: false, area, entries: [], entryCount: 0, truncated: false };
  }
  const entryCount = storage.length;
  const take = Math.min(entryCount, Math.max(0, limit));
  const entries: StorageEntry[] = [];
  for (let i = 0; i < take; i += 1) {
    const key = storage.key(i);
    if (key === null) continue;
    const capped = capValue(storage.getItem(key) ?? '');
    entries.push(
      capped.truncated
        ? { key, value: capped.value, truncated: true }
        : { key, value: capped.value },
    );
  }
  return { supported: true, area, entries, entryCount, truncated: entryCount > take };
};
