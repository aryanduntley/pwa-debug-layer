import { describe, it, expect } from 'vitest';
import { defaultSettings, settingKeys } from '@pwa-debug/shared';
import { createSettingsCache } from '../../src/ext_settings_cache/ext_settings_cache.js';

describe('ext_settings_cache — pre-snapshot defaults', () => {
  it('getSetting returns schema defaults before any payload arrives', () => {
    const c = createSettingsCache();
    expect(c.getSetting('capture.memoryCutoffPerKind')).toBe(5000);
    expect(c.getSetting('sites.allowlist')).toEqual(['*']);
    expect(c.getAll()).toEqual(defaultSettings());
  });
});

describe('ext_settings_cache — applySnapshot', () => {
  it('applies a fully-valid snapshot and reports the accepted count', () => {
    const c = createSettingsCache();
    const r = c.applySnapshot({
      values: {
        'capture.memoryCutoffPerKind': 9000,
        'capture.diskSpill.enabled': true,
        'sites.allowlist': ['ok.com/*'],
      },
    });
    expect(r.applied).toBe(3);
    expect(c.getSetting('capture.memoryCutoffPerKind')).toBe(9000);
    expect(c.getSetting('capture.diskSpill.enabled')).toBe(true);
    expect(c.getSetting('sites.allowlist')).toEqual(['ok.com/*']);
    // unset keys remain at defaults (snapshot is a fresh merge over defaults)
    expect(c.getSetting('capture.diskSpill.archiveLongevityDays')).toBe(7);
  });

  it('drops invalid values silently — only valid keys count toward applied', () => {
    const c = createSettingsCache();
    const r = c.applySnapshot({
      values: {
        'capture.memoryCutoffPerKind': -1, // invalid (negative)
        'capture.diskSpill.enabled': 'yes', // invalid (string)
        'sites.allowlist': ['ok.com/*'], // valid
      },
    });
    expect(r.applied).toBe(1);
    expect(c.getSetting('capture.memoryCutoffPerKind')).toBe(5000); // default
    expect(c.getSetting('capture.diskSpill.enabled')).toBe(false); // default
    expect(c.getSetting('sites.allowlist')).toEqual(['ok.com/*']); // applied
  });

  it('drops unknown keys silently (forward-compat with host versions adding entries)', () => {
    const c = createSettingsCache();
    const r = c.applySnapshot({
      values: {
        'capture.memoryCutoffPerKind': 1234,
        'ui.someFutureKey': 'whatever',
      },
    });
    expect(r.applied).toBe(1);
    expect(c.getSetting('capture.memoryCutoffPerKind')).toBe(1234);
  });

  it('returns { applied: 0 } for malformed payloads (no crash)', () => {
    const c = createSettingsCache();
    expect(c.applySnapshot(null).applied).toBe(0);
    expect(c.applySnapshot('not-an-object').applied).toBe(0);
    expect(c.applySnapshot(42).applied).toBe(0);
    expect(c.applySnapshot({ /* missing values */ }).applied).toBe(0);
    expect(c.applySnapshot({ values: 'not-a-record' }).applied).toBe(0);
    // state unchanged
    expect(c.getAll()).toEqual(defaultSettings());
  });

  it('a second snapshot replaces — not merges with — the first', () => {
    const c = createSettingsCache();
    c.applySnapshot({ values: { 'capture.memoryCutoffPerKind': 1, 'capture.diskSpill.enabled': true } });
    c.applySnapshot({ values: { 'capture.memoryCutoffPerKind': 2 } });
    expect(c.getSetting('capture.memoryCutoffPerKind')).toBe(2);
    // capture.diskSpill.enabled reverts to default because second snapshot omitted it
    expect(c.getSetting('capture.diskSpill.enabled')).toBe(false);
  });
});

describe('ext_settings_cache — applyChange', () => {
  it('applies a valid SettingChange', () => {
    const c = createSettingsCache();
    const r = c.applyChange({
      key: 'capture.diskSpill.enabled',
      value: true,
    });
    expect(r.applied).toBe(true);
    expect(c.getSetting('capture.diskSpill.enabled')).toBe(true);
    // other keys untouched
    expect(c.getSetting('capture.memoryCutoffPerKind')).toBe(5000);
  });

  it('drops unknown keys silently', () => {
    const c = createSettingsCache();
    const r = c.applyChange({ key: 'no.such.key', value: 1 });
    expect(r.applied).toBe(false);
    expect(c.getAll()).toEqual(defaultSettings());
  });

  it('drops invalid values silently (no crash, state unchanged)', () => {
    const c = createSettingsCache();
    const before = c.getAll();
    const cases: unknown[] = [
      { key: 'capture.memoryCutoffPerKind', value: -1 },
      { key: 'capture.diskSpill.enabled', value: 'yes' },
      { key: 'sites.allowlist', value: 'not-array' },
      { key: 'capture.enabledKinds', value: ['ooga'] },
    ];
    for (const payload of cases) {
      expect(c.applyChange(payload).applied).toBe(false);
    }
    expect(c.getAll()).toEqual(before);
  });

  it('drops malformed payloads (null, array, missing fields)', () => {
    const c = createSettingsCache();
    expect(c.applyChange(null).applied).toBe(false);
    expect(c.applyChange([]).applied).toBe(false);
    expect(c.applyChange({}).applied).toBe(false);
    expect(c.applyChange({ key: 5, value: 1 }).applied).toBe(false);
  });

  it('a change overlays on top of a prior snapshot (not the defaults)', () => {
    const c = createSettingsCache();
    c.applySnapshot({
      values: { 'capture.memoryCutoffPerKind': 9000, 'sites.allowlist': ['a'] },
    });
    c.applyChange({ key: 'capture.memoryCutoffPerKind', value: 1234 });
    // changed value visible
    expect(c.getSetting('capture.memoryCutoffPerKind')).toBe(1234);
    // unchanged key from snapshot still visible (NOT reverted to default)
    expect(c.getSetting('sites.allowlist')).toEqual(['a']);
  });
});

describe('ext_settings_cache — cross-package signature parity', () => {
  it('getSetting type signature is structurally identical to host_settings — every key reads', () => {
    // Compile-time-extensibility proof at runtime: iterating settingKeys()
    // confirms the cache's getSetting answers for every key in the shared
    // SETTINGS_SCHEMA (the same set the host_settings store iterates).
    const c = createSettingsCache();
    for (const k of settingKeys()) {
      expect(c.getSetting(k)).not.toBeUndefined();
    }
  });
});
