/**
 * Wire types for the storage-inspection tools (storage_get / idb_list /
 * idb_query) — a projection of the debugged PWA's web storage (localStorage /
 * sessionStorage) and IndexedDB. These fill the recurring "inspect IndexedDB /
 * web storage live" gap that CDP/chrome-devtools-mcp does not surface for the
 * app's real profile.
 *
 * Pure type module (no runtime). Projection + reads live in the extension
 * `storage` module; the host tools validate against these shapes.
 */

// ── Web storage (localStorage / sessionStorage) ──────────────────────────────

/** One web-storage key/value pair, value-capped. */
export type StorageEntry = {
  readonly key: string;
  readonly value: string;
  /** True when `value` was truncated to the per-value cap. */
  readonly truncated?: boolean;
};

export type StorageArea = 'local' | 'session';

export type StorageGetResult = {
  /** False when the area is unavailable (e.g. storage disabled / blocked). */
  readonly supported: boolean;
  readonly area: StorageArea;
  readonly entries: readonly StorageEntry[];
  /** Total keys in the area (entries may be capped below this). */
  readonly entryCount: number;
  /** True when entryCount exceeded the limit and entries were capped. */
  readonly truncated: boolean;
};

// ── IndexedDB structure (idb_list) ───────────────────────────────────────────

/** One index on an object store. */
export type IdbIndexInfo = {
  readonly name: string;
  readonly keyPath: string | readonly string[] | null;
  readonly unique: boolean;
  readonly multiEntry: boolean;
};

/** One object store within a database. */
export type IdbStoreInfo = {
  readonly name: string;
  readonly keyPath: string | readonly string[] | null;
  readonly autoIncrement: boolean;
  readonly indexes: readonly IdbIndexInfo[];
};

/** One IndexedDB database: its version + object stores. */
export type IdbDatabaseInfo = {
  readonly name: string;
  /** Schema version; null when it could not be read. */
  readonly version: number | null;
  readonly stores: readonly IdbStoreInfo[];
  /** Set when the database could not be opened/described (stores then empty). */
  readonly error?: string;
};

export type IdbListResult = {
  /** False when indexedDB is unavailable (insecure context / unsupported). */
  readonly supported: boolean;
  readonly databases: readonly IdbDatabaseInfo[];
};

// ── IndexedDB records (idb_query) ────────────────────────────────────────────

/** One record from an object store, key + value-capped value. */
export type IdbRecord = {
  readonly key: unknown;
  readonly value: unknown;
  /** True when `value` was truncated by the shared serializer cap. */
  readonly truncated?: boolean;
};

export type IdbQueryResult = {
  readonly supported: boolean;
  /** Whether the db AND store both exist. */
  readonly found: boolean;
  readonly db: string;
  readonly store: string;
  readonly records: readonly IdbRecord[];
  /** Number of records returned (after the limit cap). */
  readonly returned: number;
  /** True when more records exist than were returned (capped by limit). */
  readonly truncated: boolean;
  /** Set when the db/store could not be opened or read. */
  readonly error?: string;
};
