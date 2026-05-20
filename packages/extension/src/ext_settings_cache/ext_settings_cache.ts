/**
 * Extension-side typed settings cache — SW-side mirror of host_settings.
 *
 * The host sends:
 *   • One IpcEventEnvelope{ tool:'settings_snapshot', payload:{values: SettingsRecord} }
 *     on extension register/handshake.
 *   • One IpcEventEnvelope{ tool:'settings_changed', payload: SettingChange }
 *     on each host store change.
 *
 * The SW orchestrator routes the envelope's payload to applySnapshot or
 * applyChange. This module owns the cache state — nothing here knows about
 * chrome.*, sockets, or IPC framing; it accepts already-decoded payloads as
 * `unknown` and defensively validates everything at the boundary.
 *
 * Pre-snapshot, getSetting returns the schema default for every key so
 * consumers (capture pipeline at T4, future UI) tolerate boot ordering.
 */
import {
  defaultSettings,
  getSettingEntry,
  settingKeys,
  validateSettingValue,
  type SettingChange,
  type SettingKey,
  type SettingTypeMap,
  type SettingsRecord,
} from '@pwa-debug/shared';

export type SettingsCacheApplyResult = {
  readonly applied: number;
};

export type SettingsCacheChangeResult = {
  readonly applied: boolean;
};

export type ExtSettingsCache = {
  readonly getSetting: <K extends SettingKey>(key: K) => SettingTypeMap[K];
  readonly getAll: () => SettingsRecord;
  readonly applySnapshot: (payload: unknown) => SettingsCacheApplyResult;
  readonly applyChange: (payload: unknown) => SettingsCacheChangeResult;
};

const isKnownKey = (k: unknown): k is SettingKey =>
  typeof k === 'string' &&
  (settingKeys() as readonly string[]).includes(k);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export const createSettingsCache = (): ExtSettingsCache => {
  let current: SettingsRecord = defaultSettings();

  const getSetting = <K extends SettingKey>(key: K): SettingTypeMap[K] =>
    current[key];

  const getAll = (): SettingsRecord => current;

  const applySnapshot = (payload: unknown): SettingsCacheApplyResult => {
    if (!isRecord(payload)) return { applied: 0 };
    const values = payload['values'];
    if (!isRecord(values)) return { applied: 0 };
    const next: { -readonly [K in SettingKey]: SettingTypeMap[K] } = {
      ...defaultSettings(),
    };
    let applied = 0;
    for (const k of settingKeys()) {
      const v = values[k];
      if (v !== undefined && validateSettingValue(k, v)) {
        (next as Record<SettingKey, unknown>)[k] = v;
        applied += 1;
      }
    }
    current = next as SettingsRecord;
    return { applied };
  };

  const applyChange = (payload: unknown): SettingsCacheChangeResult => {
    if (!isRecord(payload)) return { applied: false };
    const key = payload['key'];
    if (!isKnownKey(key)) return { applied: false };
    const value = payload['value'];
    if (!validateSettingValue(key, value)) return { applied: false };
    // Re-narrowing: getSettingEntry confirms the key exists in schema (defensive).
    if (!getSettingEntry(key)) return { applied: false };
    current = { ...current, [key]: value } as SettingsRecord;
    return { applied: true };
  };

  return { getSetting, getAll, applySnapshot, applyChange };
};

// Re-exported for SW orchestrator's typed routing of incoming envelopes.
export type { SettingChange };
