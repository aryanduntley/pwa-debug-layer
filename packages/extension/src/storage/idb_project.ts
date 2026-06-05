/**
 * Pure projections of IndexedDB structure + records into the wire shapes
 * (IdbStoreInfo / IdbIndexInfo / IdbRecord). No indexedDB.* I/O — the readers
 * (idb_read.ts) perform the async open/transaction work and hand the
 * already-extracted fields here, keeping this unit-testable with plain objects
 * (mirrors cache_storage/project.ts's projectCacheEntry).
 */

import type { IdbIndexInfo, IdbStoreInfo, IdbRecord } from '@pwa-debug/shared';
import { serializeStoreValue } from '../stores/redux/serialize.js';

/** keyPath is a plain string, a string[] (compound key), or null (out-of-line). */
const normalizeKeyPath = (
  keyPath: string | readonly string[] | null,
): string | readonly string[] | null =>
  Array.isArray(keyPath) ? Object.freeze([...keyPath]) : (keyPath as string | null);

/** Structural view of one IDBIndex (the subset the projection reads). */
export type IdbIndexView = {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly unique: boolean;
  readonly multiEntry: boolean;
};

/** Structural view of one IDBObjectStore (the subset the projection reads). */
export type IdbStoreView = {
  readonly name: string;
  readonly keyPath: string | readonly string[] | null;
  readonly autoIncrement: boolean;
  readonly indexes: readonly IdbIndexView[];
};

export const projectIndexInfo = (idx: IdbIndexView): IdbIndexInfo =>
  Object.freeze({
    name: idx.name,
    keyPath: normalizeKeyPath(idx.keyPath),
    unique: idx.unique,
    multiEntry: idx.multiEntry,
  });

export const projectStoreInfo = (store: IdbStoreView): IdbStoreInfo =>
  Object.freeze({
    name: store.name,
    keyPath: normalizeKeyPath(store.keyPath),
    autoIncrement: store.autoIncrement,
    indexes: Object.freeze(store.indexes.map(projectIndexInfo)),
  });

/**
 * Project one record's key + value into an IdbRecord. Both are run through the
 * shared 16KB serializer (serializeStoreValue) so a large blob, cycle, or
 * DOM/Error/function value cannot blow the wire payload; `truncated` reflects
 * the VALUE cap (keys are small structured-clone types in practice).
 */
export const projectIdbRecord = (key: unknown, value: unknown): IdbRecord => {
  const serializedKey = serializeStoreValue(key);
  const serializedValue = serializeStoreValue(value);
  return serializedValue.truncated
    ? Object.freeze({ key: serializedKey.value, value: serializedValue.value, truncated: true })
    : Object.freeze({ key: serializedKey.value, value: serializedValue.value });
};
