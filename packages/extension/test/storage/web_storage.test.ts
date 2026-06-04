import { describe, it, expect } from 'vitest';
import {
  readWebStorage,
  STORAGE_VALUE_CAP,
  type StorageLike,
} from '../../src/storage/web_storage.js';

/** Minimal in-memory Storage fake honoring index order. */
const fakeStorage = (pairs: ReadonlyArray<readonly [string, string]>): StorageLike => ({
  length: pairs.length,
  key: (i) => pairs[i]?.[0] ?? null,
  getItem: (k) => pairs.find(([kk]) => kk === k)?.[1] ?? null,
});

describe('readWebStorage', () => {
  it('supported:false when the area is null (blocked/unavailable)', () => {
    expect(readWebStorage(null, 'local', 500)).toEqual({
      supported: false,
      area: 'local',
      entries: [],
      entryCount: 0,
      truncated: false,
    });
  });

  it('snapshots all entries in index order under the limit', () => {
    const r = readWebStorage(
      fakeStorage([
        ['token', 'abc'],
        ['flag', 'true'],
      ]),
      'local',
      500,
    );
    expect(r).toEqual({
      supported: true,
      area: 'local',
      entries: [
        { key: 'token', value: 'abc' },
        { key: 'flag', value: 'true' },
      ],
      entryCount: 2,
      truncated: false,
    });
  });

  it('caps the entry count to the limit and reports truncated + true total', () => {
    const r = readWebStorage(
      fakeStorage([
        ['a', '1'],
        ['b', '2'],
        ['c', '3'],
      ]),
      'session',
      2,
    );
    expect(r.area).toBe('session');
    expect(r.entries.map((e) => e.key)).toEqual(['a', 'b']);
    expect(r.entryCount).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it('caps a long value and flags truncated on that entry only', () => {
    const long = 'x'.repeat(STORAGE_VALUE_CAP + 50);
    const r = readWebStorage(fakeStorage([['big', long], ['small', 'ok']]), 'local', 500);
    expect(r.entries[0]?.value).toHaveLength(STORAGE_VALUE_CAP);
    expect(r.entries[0]?.truncated).toBe(true);
    expect(r.entries[1]).toEqual({ key: 'small', value: 'ok' });
  });

  it('treats a missing value as an empty string', () => {
    const storage: StorageLike = { length: 1, key: () => 'k', getItem: () => null };
    expect(readWebStorage(storage, 'local', 500).entries[0]).toEqual({
      key: 'k',
      value: '',
    });
  });

  it('returns no entries (but the true count) when limit is 0', () => {
    const r = readWebStorage(fakeStorage([['a', '1']]), 'local', 0);
    expect(r.entries).toEqual([]);
    expect(r.entryCount).toBe(1);
    expect(r.truncated).toBe(true);
  });
});
