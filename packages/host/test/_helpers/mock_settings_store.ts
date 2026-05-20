/**
 * Returns a fresh, never-init'd SettingsStore for buildCtx in tool tests
 * that don't exercise the settings_* tools.
 *
 * createSettingsStore is pure at construction — no fs IO until .init() is
 * called and no watcher attached when disableWatch is true — so this is safe
 * to call without any cleanup. Tests that actually drive settings behavior
 * should call createSettingsStore directly with a real tmpdir path and
 * await init().
 */
import {
  createSettingsStore,
  type SettingsStore,
} from '../../src/host_settings/host_settings.js';

export const mockSettingsStore = (): SettingsStore =>
  createSettingsStore({
    path: '/tmp/pwa-debug-mock-settings-DO_NOT_USE.json',
    disableWatch: true,
  });
