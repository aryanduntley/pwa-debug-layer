/**
 * Async IndexedDB readers — the edge that performs indexedDB.* I/O (databases(),
 * open, read-only transactions, getAll/getAllKeys) and composes the pure
 * idb_project projections. The IDBFactory is injected (defaults to the page's
 * `indexedDB` global at the call site) so these are unit-testable with a
 * hand-rolled fake factory (mirrors cache_storage/read.ts injecting a fake
 * CacheStorage).
 *
 * Strictly read-only: a read-only transaction, no writes, and open() is only
 * ever called for a database that databases() already reported — so reading
 * never creates an empty database as a side effect.
 *
 * The OOP, event-based IDB API is wrapped behind thin structural types +
 * promisifyRequest, keeping the FP/no-OOP discipline at this seam.
 */

import type {
  IdbListResult,
  IdbDatabaseInfo,
  IdbQueryResult,
} from '@pwa-debug/shared';
import { projectStoreInfo, projectIdbRecord, type IdbIndexView } from './idb_project.js';

// ── Minimal structural views of the IndexedDB API subset used ─────────────────

/** Array-like with `.item()` — matches DOMStringList (objectStoreNames/indexNames). */
export type DomStringListLike = {
  readonly length: number;
  item(index: number): string | null;
};

/** Event-based request handle — matches IDBRequest / IDBOpenDBRequest. */
export type IdbRequestLike<T> = {
  result: T;
  error: DOMException | Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};

export type IdbIndexLike = {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly unique: boolean;
  readonly multiEntry: boolean;
};

export type IdbObjectStoreLike = {
  readonly name: string;
  readonly keyPath: string | readonly string[] | null;
  readonly autoIncrement: boolean;
  readonly indexNames: DomStringListLike;
  index(name: string): IdbIndexLike;
  getAll(query?: undefined, count?: number): IdbRequestLike<unknown[]>;
  getAllKeys(query?: undefined, count?: number): IdbRequestLike<unknown[]>;
};

export type IdbTransactionLike = {
  objectStore(name: string): IdbObjectStoreLike;
};

export type IdbDatabaseLike = {
  readonly version: number;
  readonly objectStoreNames: DomStringListLike;
  transaction(storeNames: readonly string[], mode: 'readonly'): IdbTransactionLike;
  close?(): void;
};

export type IdbOpenRequestLike = IdbRequestLike<IdbDatabaseLike> & {
  onupgradeneeded?: (() => void) | null;
  onblocked?: (() => void) | null;
};

export type IdbDatabaseListing = { readonly name?: string; readonly version?: number };

export type IdbFactoryLike = {
  databases?: () => Promise<readonly IdbDatabaseListing[]>;
  open(name: string): IdbOpenRequestLike;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const listToArray = (list: DomStringListLike): string[] => {
  const out: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const v = list.item(i);
    if (v !== null) out.push(v);
  }
  return out;
};

const promisifyRequest = <T>(req: IdbRequestLike<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

const openDb = (factory: IdbFactoryLike, name: string): Promise<IdbDatabaseLike> =>
  promisifyRequest(factory.open(name));

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const indexViews = (store: IdbObjectStoreLike): IdbIndexView[] =>
  listToArray(store.indexNames).map((name) => {
    const idx = store.index(name);
    return {
      name: idx.name,
      keyPath: idx.keyPath,
      unique: idx.unique,
      multiEntry: idx.multiEntry,
    };
  });

// ── idb_list ─────────────────────────────────────────────────────────────────

/** Open a single database read-only and describe its object stores + indexes. */
const describeDatabase = async (
  factory: IdbFactoryLike,
  name: string,
  version: number | null,
): Promise<IdbDatabaseInfo> => {
  let db: IdbDatabaseLike;
  try {
    db = await openDb(factory, name);
  } catch (err) {
    return Object.freeze({ name, version, stores: [], error: errorMessage(err) });
  }
  try {
    const storeNames = listToArray(db.objectStoreNames);
    const resolvedVersion = typeof db.version === 'number' ? db.version : version;
    if (storeNames.length === 0) {
      db.close?.();
      return Object.freeze({ name, version: resolvedVersion, stores: [] });
    }
    const tx = db.transaction(storeNames, 'readonly');
    const stores = storeNames.map((sn) => {
      const os = tx.objectStore(sn);
      return projectStoreInfo({
        name: os.name,
        keyPath: os.keyPath,
        autoIncrement: os.autoIncrement,
        indexes: indexViews(os),
      });
    });
    db.close?.();
    return Object.freeze({ name, version: resolvedVersion, stores: Object.freeze(stores) });
  } catch (err) {
    db.close?.();
    return Object.freeze({ name, version, stores: [], error: errorMessage(err) });
  }
};

/**
 * List every IndexedDB database (name + version) and describe each one's object
 * stores. `factory === null` (insecure/unsupported context) yields
 * supported:false; a browser whose indexedDB lacks the databases() enumeration
 * API yields supported:true with an empty list (can't enumerate).
 */
export const readIdbList = async (
  factory: IdbFactoryLike | null,
): Promise<IdbListResult> => {
  if (factory === null || typeof factory.databases !== 'function') {
    return { supported: false, databases: [] };
  }
  const listings = await factory.databases();
  const named = listings.filter(
    (d): d is { name: string; version?: number } =>
      typeof d.name === 'string' && d.name.length > 0,
  );
  const databases = await Promise.all(
    named.map((d) => describeDatabase(factory, d.name, d.version ?? null)),
  );
  return { supported: true, databases: Object.freeze(databases) };
};

// ── idb_query ────────────────────────────────────────────────────────────────

const emptyQuery = (
  db: string,
  store: string,
  supported: boolean,
  found: boolean,
  error?: string,
): IdbQueryResult =>
  Object.freeze({
    supported,
    found,
    db,
    store,
    records: [],
    returned: 0,
    truncated: false,
    ...(error !== undefined ? { error } : {}),
  });

/**
 * Read a capped, read-only slice of records (key + value) from one object store.
 * Fetches limit+1 via getAll/getAllKeys so truncation is detected without
 * counting the whole store; each value is capped by the shared 16KB serializer.
 * found:false when the db or store does not exist; never creates the database
 * (membership is confirmed via databases() before open()).
 */
export const readIdbQuery = async (
  factory: IdbFactoryLike | null,
  dbName: string,
  storeName: string,
  limit: number,
): Promise<IdbQueryResult> => {
  if (factory === null) return emptyQuery(dbName, storeName, false, false);

  if (typeof factory.databases === 'function') {
    const listings = await factory.databases();
    if (!listings.some((d) => d.name === dbName)) {
      return emptyQuery(dbName, storeName, true, false);
    }
  }

  let db: IdbDatabaseLike;
  try {
    db = await openDb(factory, dbName);
  } catch (err) {
    return emptyQuery(dbName, storeName, true, false, errorMessage(err));
  }

  if (!listToArray(db.objectStoreNames).includes(storeName)) {
    db.close?.();
    return emptyQuery(dbName, storeName, true, false);
  }

  try {
    const tx = db.transaction([storeName], 'readonly');
    const os = tx.objectStore(storeName);
    const fetchCount = Math.max(0, limit) + 1;
    const values = await promisifyRequest(os.getAll(undefined, fetchCount));
    const keys = await promisifyRequest(os.getAllKeys(undefined, fetchCount));
    db.close?.();
    const truncated = values.length > limit;
    const records = values
      .slice(0, limit)
      .map((value, i) => projectIdbRecord(keys[i], value));
    return Object.freeze({
      supported: true,
      found: true,
      db: dbName,
      store: storeName,
      records: Object.freeze(records),
      returned: records.length,
      truncated,
    });
  } catch (err) {
    db.close?.();
    // The store exists (confirmed above) but the read failed — found stays true.
    return Object.freeze({
      supported: true,
      found: true,
      db: dbName,
      store: storeName,
      records: [],
      returned: 0,
      truncated: false,
      error: errorMessage(err),
    });
  }
};
