import { describe, it, expect } from 'vitest';
import { readIdbList, readIdbQuery } from '../../src/storage/idb_read.js';
import type {
  IdbFactoryLike,
  IdbRequestLike,
  IdbDatabaseLike,
  IdbObjectStoreLike,
  IdbOpenRequestLike,
  DomStringListLike,
} from '../../src/storage/idb_read.js';

// ── Hand-rolled fakes (no fake-indexeddb dep; mirror cache_storage fake) ──────

type IndexSpec = {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
  multiEntry?: boolean;
};
type StoreSpec = {
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
  indexes?: IndexSpec[];
  records?: { key: unknown; value: unknown }[];
};
type DbSpec = { version?: number; stores: Record<string, StoreSpec> };

const stringList = (names: readonly string[]): DomStringListLike => ({
  length: names.length,
  item: (i) => names[i] ?? null,
});

/** Fires onsuccess on the next microtask (after promisifyRequest binds it). */
const fakeRequest = <T>(result: T): IdbRequestLike<T> => {
  const req: IdbRequestLike<T> = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => req.onsuccess?.());
  return req;
};

const fakeFailingRequest = <T>(message: string): IdbRequestLike<T> => {
  const req: IdbRequestLike<T> = {
    result: undefined as T,
    error: new Error(message),
    onsuccess: null,
    onerror: null,
  };
  queueMicrotask(() => req.onerror?.());
  return req;
};

const fakeObjectStore = (name: string, spec: StoreSpec): IdbObjectStoreLike => {
  const indexes = spec.indexes ?? [];
  const records = spec.records ?? [];
  return {
    name,
    keyPath: spec.keyPath ?? null,
    autoIncrement: spec.autoIncrement ?? false,
    indexNames: stringList(indexes.map((i) => i.name)),
    index: (n) => {
      const idx = indexes.find((i) => i.name === n)!;
      return {
        name: idx.name,
        keyPath: idx.keyPath,
        unique: idx.unique ?? false,
        multiEntry: idx.multiEntry ?? false,
      };
    },
    getAll: (_q, count) =>
      fakeRequest(records.map((r) => r.value).slice(0, count ?? records.length)),
    getAllKeys: (_q, count) =>
      fakeRequest(records.map((r) => r.key).slice(0, count ?? records.length)),
  };
};

const fakeDatabase = (spec: DbSpec): IdbDatabaseLike => {
  const storeNames = Object.keys(spec.stores);
  return {
    version: spec.version ?? 1,
    objectStoreNames: stringList(storeNames),
    transaction: () => ({
      objectStore: (n) => fakeObjectStore(n, spec.stores[n]!),
    }),
    close: () => {},
  };
};

type FactoryOpts = { omitDatabases?: boolean; openError?: string };

const fakeFactory = (
  dbs: Record<string, DbSpec>,
  opts: FactoryOpts = {},
): IdbFactoryLike => {
  const factory: IdbFactoryLike = {
    open: (name): IdbOpenRequestLike => {
      if (opts.openError !== undefined) return fakeFailingRequest(opts.openError);
      return fakeRequest(fakeDatabase(dbs[name]!));
    },
  };
  if (!opts.omitDatabases) {
    factory.databases = () =>
      Promise.resolve(Object.entries(dbs).map(([name, d]) => ({ name, version: d.version ?? 1 })));
  }
  return factory;
};

// ── readIdbList ──────────────────────────────────────────────────────────────

describe('readIdbList', () => {
  it('supported:false when the factory is null', async () => {
    expect(await readIdbList(null)).toEqual({ supported: false, databases: [] });
  });

  it('supported:false when databases() enumeration is unavailable', async () => {
    const f = fakeFactory({ app: { stores: { items: {} } } }, { omitDatabases: true });
    expect(await readIdbList(f)).toEqual({ supported: false, databases: [] });
  });

  it('lists databases with their stores + indexes', async () => {
    const f = fakeFactory({
      app: {
        version: 3,
        stores: {
          users: {
            keyPath: 'id',
            autoIncrement: false,
            indexes: [{ name: 'by_email', keyPath: 'email', unique: true }],
          },
          logs: { keyPath: null, autoIncrement: true, indexes: [] },
        },
      },
    });
    const r = await readIdbList(f);
    expect(r.supported).toBe(true);
    expect(r.databases).toHaveLength(1);
    const db = r.databases[0]!;
    expect(db.name).toBe('app');
    expect(db.version).toBe(3);
    expect(db.stores.map((s) => s.name)).toEqual(['users', 'logs']);
    expect(db.stores[0]!.keyPath).toBe('id');
    expect(db.stores[0]!.indexes[0]).toEqual({
      name: 'by_email',
      keyPath: 'email',
      unique: true,
      multiEntry: false,
    });
    expect(db.stores[1]!.autoIncrement).toBe(true);
  });

  it('reports a per-database error when the db cannot be opened', async () => {
    const f = fakeFactory({ broken: { stores: {} } }, { openError: 'open denied' });
    const r = await readIdbList(f);
    expect(r.supported).toBe(true);
    expect(r.databases[0]).toMatchObject({ name: 'broken', stores: [], error: 'open denied' });
  });

  it('skips listings with no name', async () => {
    const f: IdbFactoryLike = {
      databases: () => Promise.resolve([{ version: 1 }, { name: 'real', version: 2 }]),
      open: () => fakeRequest(fakeDatabase({ stores: { s: {} } })),
    };
    const r = await readIdbList(f);
    expect(r.databases.map((d) => d.name)).toEqual(['real']);
  });
});

// ── readIdbQuery ─────────────────────────────────────────────────────────────

const queryFactory = () =>
  fakeFactory({
    app: {
      stores: {
        items: {
          records: [
            { key: 1, value: { name: 'a' } },
            { key: 2, value: { name: 'b' } },
            { key: 3, value: { name: 'c' } },
          ],
        },
      },
    },
  });

describe('readIdbQuery', () => {
  it('supported:false when the factory is null', async () => {
    const r = await readIdbQuery(null, 'app', 'items', 100);
    expect(r).toMatchObject({ supported: false, found: false, records: [] });
  });

  it('found:false for a missing database', async () => {
    const r = await readIdbQuery(queryFactory(), 'nope', 'items', 100);
    expect(r).toMatchObject({ supported: true, found: false, db: 'nope', records: [] });
  });

  it('found:false for a missing store', async () => {
    const r = await readIdbQuery(queryFactory(), 'app', 'ghost', 100);
    expect(r).toMatchObject({ supported: true, found: false, store: 'ghost', records: [] });
  });

  it('returns a slice of records key + value', async () => {
    const r = await readIdbQuery(queryFactory(), 'app', 'items', 100);
    expect(r.found).toBe(true);
    expect(r.returned).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.records).toEqual([
      { key: 1, value: { name: 'a' } },
      { key: 2, value: { name: 'b' } },
      { key: 3, value: { name: 'c' } },
    ]);
  });

  it('caps to the limit and flags truncated (fetches limit+1 to detect)', async () => {
    const r = await readIdbQuery(queryFactory(), 'app', 'items', 2);
    expect(r.returned).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.records.map((rec) => rec.key)).toEqual([1, 2]);
  });

  it('found:false with an error when the open fails', async () => {
    const f = fakeFactory(
      { app: { stores: { items: {} } } },
      { openError: 'read blocked' },
    );
    const r = await readIdbQuery(f, 'app', 'items', 100);
    // db is in the listing, but open() errored before the store could be confirmed.
    expect(r).toMatchObject({ supported: true, found: false, error: 'read blocked' });
  });
});
