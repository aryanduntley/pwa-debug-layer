/**
 * Returns a fresh, never-init'd SettingsStore for buildCtx in tool tests
 * that don't exercise the settings_* tools.
 *
 * createSettingsStore is pure at construction — no fs IO until .init() is
 * called and no watcher attached when disableWatch is true — so this is safe
 * to call without any cleanup. Tests that actually drive settings behavior
 * should call createSettingsStore directly with a real tmpdir path and
 * await init().
 *
 * Optional `overrides` lets a test return non-default values from getSetting
 * without going through disk persistence. The returned store wraps the real
 * one's getSetting/getAll with the override map; everything else passes
 * through unchanged.
 */
import {
  createSettingsStore,
  type SettingsStore,
} from '../../src/host_settings/host_settings.js';
import type {
  SettingKey,
  SettingTypeMap,
  SettingsRecord,
} from '@pwa-debug/shared';

export const mockSettingsStore = (
  overrides: Partial<SettingsRecord> = {},
): SettingsStore => {
  const base = createSettingsStore({
    path: '/tmp/pwa-debug-mock-settings-DO_NOT_USE.json',
    disableWatch: true,
  });
  if (Object.keys(overrides).length === 0) return base;
  return {
    init: base.init,
    setSetting: base.setSetting,
    subscribe: base.subscribe,
    dispose: base.dispose,
    getSetting: <K extends SettingKey>(key: K): SettingTypeMap[K] => {
      if (key in overrides) {
        return (overrides as Record<SettingKey, unknown>)[
          key
        ] as SettingTypeMap[K];
      }
      return base.getSetting(key);
    },
    getAll: () =>
      ({
        ...base.getAll(),
        ...overrides,
      }) as SettingsRecord,
  };
};
