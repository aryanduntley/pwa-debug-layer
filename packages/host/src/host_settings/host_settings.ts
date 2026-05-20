/**
 * Host-side typed settings store.
 *
 * Owns the persisted ~/.config/pwa-debug/settings.json file. Drives every
 * user-tunable behavior via the shared SETTINGS_SCHEMA — no setting key is
 * hardcoded here, so adding a key is one schema entry, zero changes to this
 * file or any other consumer.
 *
 * Layering:
 *   • Pure transforms (parsePersistedSettings, mergeOverDefaults,
 *     diffChangedKeys) exported separately so the extension cache (T3) and
 *     tests can reuse them without instantiating a store.
 *   • createSettingsStore composes those transforms with fs side effects at
 *     the module's edges (host_io.readJsonOr / atomicWriteJson + fs.watch).
 *
 * Subscriber model:
 *   • setSetting → atomic persist → notify subscribers once (one SettingChange).
 *   • External edit → fs.watch fires → debounce → reload+merge → diff → notify
 *     once per changed key. Self-writes are guarded by mtime comparison so the
 *     host doesn't re-notify its own writes.
 */
import { stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import {
  type SettingChange,
  type SettingKey,
  type SettingTypeMap,
  type SettingsRecord,
  defaultSettings,
  getSettingEntry,
  settingKeys,
  validateSettingValue,
} from '@pwa-debug/shared';
import {
  atomicWriteJson,
  readJsonOr,
  xdgConfigPath,
  type XdgEnv,
} from '../host_io/host_io.js';

export type SettingsStoreOptions = {
  readonly path?: string;
  readonly env?: XdgEnv;
  readonly disableWatch?: boolean;
  readonly watchDebounceMs?: number;
};

export type SetSettingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type SettingsListener = (change: SettingChange) => void;
export type SettingsDisposer = () => void;

export type SettingsStore = {
  readonly init: () => Promise<void>;
  readonly getSetting: <K extends SettingKey>(key: K) => SettingTypeMap[K];
  readonly getAll: () => SettingsRecord;
  readonly setSetting: <K extends SettingKey>(
    key: K,
    value: SettingTypeMap[K],
  ) => Promise<SetSettingResult>;
  readonly subscribe: (listener: SettingsListener) => SettingsDisposer;
  readonly dispose: () => void;
};

const DEFAULT_WATCH_DEBOUNCE_MS = 50;

// --- internal equality (arrays compared element-wise; primitives by ===) ---

const arraysEqual = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const valuesEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return arraysEqual(a, b);
  return false;
};

// --- pure transforms (exported, tracked) ---

export const parsePersistedSettings = (
  raw: unknown,
): Partial<SettingsRecord> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const partial: { -readonly [K in SettingKey]?: SettingTypeMap[K] } = {};
  for (const k of settingKeys()) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (validateSettingValue(k, v)) {
      // TS can't narrow a union-indexed assignment past validateSettingValue's
      // per-key guard; the runtime guard above is the actual proof.
      (partial as Record<SettingKey, unknown>)[k] = v;
    }
  }
  return partial;
};

export const mergeOverDefaults = (
  persisted: Partial<SettingsRecord>,
): SettingsRecord => {
  const out: { -readonly [K in SettingKey]: SettingTypeMap[K] } = {
    ...defaultSettings(),
  };
  for (const k of settingKeys()) {
    const p = (persisted as Partial<Record<SettingKey, unknown>>)[k];
    if (p !== undefined && validateSettingValue(k, p)) {
      (out as Record<SettingKey, unknown>)[k] = p;
    }
  }
  return out as SettingsRecord;
};

export const diffChangedKeys = (
  prev: SettingsRecord,
  next: SettingsRecord,
): readonly SettingKey[] =>
  settingKeys().filter((k) => !valuesEqual(prev[k], next[k]));

// --- closure factory (side effects at edges) ---

const makeChange = <K extends SettingKey>(
  key: K,
  value: SettingTypeMap[K],
): SettingChange => ({ key, value }) as SettingChange;

export const createSettingsStore = (
  options: SettingsStoreOptions = {},
): SettingsStore => {
  const env = options.env ?? (process.env as XdgEnv);
  const path = options.path ?? xdgConfigPath('settings.json', env);
  const debounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  const watchEnabled = options.disableWatch !== true;

  let current: SettingsRecord = defaultSettings();
  const subscribers = new Set<SettingsListener>();
  let watcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let lastSelfWriteMtimeMs: number | null = null;
  let disposed = false;

  const notify = (change: SettingChange): void => {
    for (const listener of subscribers) {
      try {
        listener(change);
      } catch {
        // listeners must not break the dispatch loop
      }
    }
  };

  const loadFromDisk = async (): Promise<SettingsRecord> => {
    const persisted = await readJsonOr<Partial<SettingsRecord>>(
      path,
      {},
      parsePersistedSettings,
    );
    return mergeOverDefaults(persisted);
  };

  const reloadAndNotify = async (): Promise<void> => {
    if (disposed) return;
    // Self-write guard: if file mtime matches the last persist we did, skip.
    try {
      const s = await stat(path);
      if (lastSelfWriteMtimeMs !== null && s.mtimeMs === lastSelfWriteMtimeMs) {
        return;
      }
    } catch {
      // missing file -> proceed; loadFromDisk will fall back to defaults
    }
    const next = await loadFromDisk();
    const changedKeys = diffChangedKeys(current, next);
    current = next;
    for (const k of changedKeys) {
      notify(makeChange(k, current[k]));
    }
  };

  const onWatchEvent = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void reloadAndNotify();
    }, debounceMs);
  };

  const startWatcher = (): void => {
    if (!watchEnabled || disposed) return;
    try {
      watcher = watch(path, { persistent: false }, onWatchEvent);
    } catch {
      // file may not exist yet; first setSetting creates it then re-attaches.
      watcher = null;
    }
  };

  const restartWatcher = (): void => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    startWatcher();
  };

  const init = async (): Promise<void> => {
    current = await loadFromDisk();
    startWatcher();
  };

  const getSetting = <K extends SettingKey>(key: K): SettingTypeMap[K] =>
    current[key];

  const getAll = (): SettingsRecord => current;

  const setSetting = async <K extends SettingKey>(
    key: K,
    value: SettingTypeMap[K],
  ): Promise<SetSettingResult> => {
    if (!validateSettingValue(key, value)) {
      const entry = getSettingEntry(key);
      const enumSuffix = entry.enumValues
        ? ` of ${entry.enumValues.join('|')}`
        : '';
      return {
        ok: false,
        error: `host_settings: value rejected by validator for '${key}' (expected ${entry.type}${enumSuffix})`,
      };
    }
    if (valuesEqual(current[key], value)) {
      // idempotent no-op: no persist, no notify
      return { ok: true };
    }
    const next: SettingsRecord = { ...current, [key]: value };
    await atomicWriteJson(path, next);
    try {
      const s = await stat(path);
      lastSelfWriteMtimeMs = s.mtimeMs;
    } catch {
      lastSelfWriteMtimeMs = null;
    }
    // Atomic rename replaces the inode; re-attach the watcher so external
    // edits to the new file are observed.
    restartWatcher();
    current = next;
    notify(makeChange(key, value));
    return { ok: true };
  };

  const subscribe = (listener: SettingsListener): SettingsDisposer => {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    subscribers.clear();
  };

  return { init, getSetting, getAll, setSetting, subscribe, dispose };
};
