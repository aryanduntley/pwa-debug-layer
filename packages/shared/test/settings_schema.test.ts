import { describe, it, expect } from 'vitest';
import {
  CAPTURE_KINDS,
  SETTINGS_SCHEMA,
  defaultSettings,
  getSettingEntry,
  settingKeys,
  validateSettingValue,
  type SettingKey,
} from '../src/index.js';

const EXPECTED_KEYS: readonly SettingKey[] = [
  'capture.memoryCutoffPerKind',
  'capture.diskSpill.enabled',
  'capture.diskSpill.archiveLongevityDays',
  'capture.diskSpill.maxBytes',
  'sites.allowlist',
  'sites.blocklist',
  'capture.enabledKinds',
];

describe('SETTINGS_SCHEMA integrity', () => {
  it('exposes the expected keys in stable schema-declaration order', () => {
    expect(settingKeys()).toEqual(EXPECTED_KEYS);
  });

  it('every entry has type, default, scope, description, and validate', () => {
    for (const k of settingKeys()) {
      const e = getSettingEntry(k);
      expect(e.key).toBe(k);
      expect(typeof e.type).toBe('string');
      expect(['number', 'boolean', 'string[]', 'enum[]']).toContain(e.type);
      expect(['host', 'extension', 'both']).toContain(e.scope);
      expect(typeof e.description).toBe('string');
      expect(e.description.length).toBeGreaterThan(0);
      expect(typeof e.validate).toBe('function');
      expect(e.default).not.toBeUndefined();
    }
  });

  it("every entry's default passes its own validator (no self-inconsistent entry)", () => {
    for (const k of settingKeys()) {
      const e = getSettingEntry(k);
      expect(e.validate(e.default)).toBe(true);
    }
  });

  it('enum[] entries carry enumValues; non-enum entries do not', () => {
    for (const k of settingKeys()) {
      const e = getSettingEntry(k);
      if (e.type === 'enum[]') {
        expect(Array.isArray(e.enumValues)).toBe(true);
        expect((e.enumValues ?? []).length).toBeGreaterThan(0);
      } else {
        expect(e.enumValues).toBeUndefined();
      }
    }
  });

  it('CAPTURE_KINDS lists the four expected kinds', () => {
    expect(CAPTURE_KINDS).toEqual(['console', 'network', 'dom_mutations', 'lifecycle']);
  });

  it('SETTINGS_SCHEMA is frozen', () => {
    expect(Object.isFrozen(SETTINGS_SCHEMA)).toBe(true);
  });
});

describe('validateSettingValue — number entries', () => {
  it('accepts non-negative integers', () => {
    expect(validateSettingValue('capture.memoryCutoffPerKind', 0)).toBe(true);
    expect(validateSettingValue('capture.memoryCutoffPerKind', 5000)).toBe(true);
    expect(validateSettingValue('capture.diskSpill.maxBytes', 100_000_000)).toBe(true);
  });

  it('rejects negatives, floats, NaN, Infinity, and non-numbers', () => {
    expect(validateSettingValue('capture.memoryCutoffPerKind', -1)).toBe(false);
    expect(validateSettingValue('capture.memoryCutoffPerKind', 1.5)).toBe(false);
    expect(validateSettingValue('capture.memoryCutoffPerKind', Number.NaN)).toBe(false);
    expect(validateSettingValue('capture.memoryCutoffPerKind', Number.POSITIVE_INFINITY)).toBe(false);
    expect(validateSettingValue('capture.memoryCutoffPerKind', '5000')).toBe(false);
    expect(validateSettingValue('capture.memoryCutoffPerKind', null)).toBe(false);
    expect(validateSettingValue('capture.memoryCutoffPerKind', undefined)).toBe(false);
  });
});

describe('validateSettingValue — boolean entries', () => {
  it('accepts true and false', () => {
    expect(validateSettingValue('capture.diskSpill.enabled', true)).toBe(true);
    expect(validateSettingValue('capture.diskSpill.enabled', false)).toBe(true);
  });
  it('rejects truthy/falsy non-booleans', () => {
    expect(validateSettingValue('capture.diskSpill.enabled', 1)).toBe(false);
    expect(validateSettingValue('capture.diskSpill.enabled', 0)).toBe(false);
    expect(validateSettingValue('capture.diskSpill.enabled', 'true')).toBe(false);
    expect(validateSettingValue('capture.diskSpill.enabled', null)).toBe(false);
  });
});

describe('validateSettingValue — string[] entries', () => {
  it('accepts empty and populated string arrays', () => {
    expect(validateSettingValue('sites.allowlist', [])).toBe(true);
    expect(validateSettingValue('sites.allowlist', ['*'])).toBe(true);
    expect(validateSettingValue('sites.blocklist', ['https://example.com/*', '*.tracking.com'])).toBe(true);
  });
  it('rejects non-arrays and arrays with non-string elements', () => {
    expect(validateSettingValue('sites.allowlist', 'string-not-array')).toBe(false);
    expect(validateSettingValue('sites.allowlist', ['ok', 42])).toBe(false);
    expect(validateSettingValue('sites.allowlist', ['ok', null])).toBe(false);
    expect(validateSettingValue('sites.allowlist', null)).toBe(false);
  });
});

describe('validateSettingValue — capture.enabledKinds (enum[])', () => {
  it('accepts the empty subset and any unique subset of CAPTURE_KINDS', () => {
    expect(validateSettingValue('capture.enabledKinds', [])).toBe(true);
    expect(validateSettingValue('capture.enabledKinds', ['console'])).toBe(true);
    expect(validateSettingValue('capture.enabledKinds', ['console', 'network'])).toBe(true);
    expect(
      validateSettingValue('capture.enabledKinds', ['console', 'network', 'dom_mutations', 'lifecycle']),
    ).toBe(true);
  });
  it('rejects unknown kinds, duplicates, and non-arrays', () => {
    expect(validateSettingValue('capture.enabledKinds', ['ooga-booga'])).toBe(false);
    expect(validateSettingValue('capture.enabledKinds', ['console', 'console'])).toBe(false);
    expect(validateSettingValue('capture.enabledKinds', 'console')).toBe(false);
    expect(validateSettingValue('capture.enabledKinds', null)).toBe(false);
  });
});

describe('defaultSettings', () => {
  it('returns every key with its schema default', () => {
    const d = defaultSettings();
    expect(d['capture.memoryCutoffPerKind']).toBe(5000);
    expect(d['capture.diskSpill.enabled']).toBe(false);
    expect(d['capture.diskSpill.archiveLongevityDays']).toBe(7);
    expect(d['capture.diskSpill.maxBytes']).toBe(100_000_000);
    expect(d['sites.allowlist']).toEqual(['*']);
    expect(d['sites.blocklist']).toEqual([]);
    expect(d['capture.enabledKinds']).toEqual(['console', 'network', 'dom_mutations', 'lifecycle']);
  });

  it('returns array defaults as fresh clones, not aliases of the schema', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    expect(a['sites.allowlist']).not.toBe(b['sites.allowlist']);
    expect(a['capture.enabledKinds']).not.toBe(b['capture.enabledKinds']);
    // Schema arrays themselves are not aliased into the result either:
    expect(a['sites.allowlist']).not.toBe(getSettingEntry('sites.allowlist').default);
  });

  it('every produced value passes its key validator', () => {
    const d = defaultSettings();
    for (const k of settingKeys()) {
      expect(validateSettingValue(k, d[k])).toBe(true);
    }
  });
});
