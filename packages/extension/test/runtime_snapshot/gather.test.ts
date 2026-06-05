import { describe, it, expect } from 'vitest';
import {
  gatherRuntimeSnapshot,
  type SnapshotDeps,
} from '../../src/runtime_snapshot/gather.js';
import type {
  SwStatusSnapshot,
  StorageGetResult,
  IdbListResult,
  CacheListResult,
  RuntimeStoreState,
} from '@pwa-debug/shared';

const sw: SwStatusSnapshot = {
  supported: true,
  controller: null,
  registrations: [],
  hasWaitingUpdate: false,
};

const idb: IdbListResult = { supported: true, databases: [] };
const cacheNames: CacheListResult = {
  supported: true,
  caches: [{ name: 'v1', entryCount: 2 }],
};

const storage = (area: 'local' | 'session'): StorageGetResult => ({
  supported: true,
  area,
  entries: [{ key: `${area}-k`, value: 'v' }],
  entryCount: 1,
  truncated: false,
});

const deps = (
  store: RuntimeStoreState,
  over: Partial<SnapshotDeps> = {},
): SnapshotDeps => ({
  readMeta: () => ({ url: 'https://app/', title: 'App', capturedAt: 1234 }),
  readSw: () => Promise.resolve(sw),
  readStore: () => store,
  readWebStorage: (area) => storage(area),
  readIdbList: () => Promise.resolve(idb),
  readCacheList: () => Promise.resolve(cacheNames),
  ...over,
});

describe('gatherRuntimeSnapshot', () => {
  it('composes every reader into one snapshot with page meta', async () => {
    const snap = await gatherRuntimeSnapshot(
      deps({ framework: 'redux', state: { count: 1 } }),
    );
    expect(snap.url).toBe('https://app/');
    expect(snap.title).toBe('App');
    expect(snap.capturedAt).toBe(1234);
    expect(snap.sw).toBe(sw);
    expect(snap.idb).toBe(idb);
    expect(snap.cacheNames).toBe(cacheNames);
    expect(snap.store).toEqual({ framework: 'redux', state: { count: 1 } });
  });

  it('captures both web-storage areas distinctly', async () => {
    const snap = await gatherRuntimeSnapshot(deps(null));
    expect(snap.webStorage.local.area).toBe('local');
    expect(snap.webStorage.session.area).toBe('session');
    expect(snap.webStorage.local.entries[0]!.key).toBe('local-k');
    expect(snap.webStorage.session.entries[0]!.key).toBe('session-k');
  });

  it('passes through store:null when no store was detected', async () => {
    const snap = await gatherRuntimeSnapshot(deps(null));
    expect(snap.store).toBeNull();
  });

  it('reads the SW / IDB / cache list concurrently (all awaited)', async () => {
    const order: string[] = [];
    const snap = await gatherRuntimeSnapshot(
      deps(null, {
        readSw: () => Promise.resolve(sw).then((v) => (order.push('sw'), v)),
        readIdbList: () => Promise.resolve(idb).then((v) => (order.push('idb'), v)),
        readCacheList: () =>
          Promise.resolve(cacheNames).then((v) => (order.push('cache'), v)),
      }),
    );
    expect(snap.sw).toBe(sw);
    expect(order).toHaveLength(3);
  });
});
