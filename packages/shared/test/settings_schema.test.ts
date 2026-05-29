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
  'sites.readControls',
  'capture.filters',
  'capture.stores.allowDispatch',
  'capture.sourceMap.enabled',
  'launch.defaultPort',
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
      expect(['number', 'boolean', 'string[]', 'enum[]', 'record']).toContain(e.type);
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

  it('CAPTURE_KINDS lists every expected kind', () => {
    expect(CAPTURE_KINDS).toEqual(['console', 'network', 'dom_mutations', 'lifecycle', 'store_change', 'replay', 'library_popup', 'page_error']);
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
    expect(validateSettingValue('capture.stores.allowDispatch', true)).toBe(true);
    expect(validateSettingValue('capture.stores.allowDispatch', false)).toBe(true);
  });
  it('rejects truthy/falsy non-booleans', () => {
    expect(validateSettingValue('capture.diskSpill.enabled', 1)).toBe(false);
    expect(validateSettingValue('capture.diskSpill.enabled', 0)).toBe(false);
    expect(validateSettingValue('capture.diskSpill.enabled', 'true')).toBe(false);
    expect(validateSettingValue('capture.diskSpill.enabled', null)).toBe(false);
    expect(validateSettingValue('capture.stores.allowDispatch', 1)).toBe(false);
    expect(validateSettingValue('capture.stores.allowDispatch', 'true')).toBe(false);
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

describe('validateSettingValue — sites.readControls (record)', () => {
  it('accepts the empty record', () => {
    expect(validateSettingValue('sites.readControls', {})).toBe(true);
  });

  it('accepts a well-formed record with per-kind boolean flags', () => {
    expect(
      validateSettingValue('sites.readControls', {
        '*.tracking.com/*': { console: false, network: false },
        'https://ok.com/*': { dom_mutations: true },
      }),
    ).toBe(true);
  });

  it('accepts an entry with no flags (empty inner object = no restriction)', () => {
    expect(
      validateSettingValue('sites.readControls', {
        'https://ok.com/*': {},
      }),
    ).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateSettingValue('sites.readControls', null)).toBe(false);
    expect(validateSettingValue('sites.readControls', undefined)).toBe(false);
    expect(validateSettingValue('sites.readControls', 'not-an-object')).toBe(false);
    expect(validateSettingValue('sites.readControls', 42)).toBe(false);
    expect(validateSettingValue('sites.readControls', [])).toBe(false);
  });

  it('rejects records whose values are not plain objects', () => {
    expect(
      validateSettingValue('sites.readControls', { '*.x.com/*': null }),
    ).toBe(false);
    expect(
      validateSettingValue('sites.readControls', { '*.x.com/*': 'console' }),
    ).toBe(false);
    expect(
      validateSettingValue('sites.readControls', { '*.x.com/*': ['console'] }),
    ).toBe(false);
  });

  it('rejects unknown CaptureKind sub-keys', () => {
    expect(
      validateSettingValue('sites.readControls', {
        '*.x.com/*': { 'not-a-kind': false },
      }),
    ).toBe(false);
    expect(
      validateSettingValue('sites.readControls', {
        '*.x.com/*': { console: false, bogus: true },
      }),
    ).toBe(false);
  });

  it('rejects non-boolean sub-values', () => {
    expect(
      validateSettingValue('sites.readControls', {
        '*.x.com/*': { console: 'false' },
      }),
    ).toBe(false);
    expect(
      validateSettingValue('sites.readControls', {
        '*.x.com/*': { console: 1 },
      }),
    ).toBe(false);
    expect(
      validateSettingValue('sites.readControls', {
        '*.x.com/*': { console: null },
      }),
    ).toBe(false);
  });
});

describe('validateSettingValue — capture.filters (record)', () => {
  it('accepts the empty record', () => {
    expect(validateSettingValue('capture.filters', {})).toBe(true);
  });

  it('accepts a record with level-only filter', () => {
    expect(
      validateSettingValue('capture.filters', {
        console: { level: ['error', 'warn'] },
      }),
    ).toBe(true);
  });

  it('accepts a record with pattern-only filter', () => {
    expect(
      validateSettingValue('capture.filters', {
        network: { pattern: { include: ['^/api'], exclude: ['/health$'] } },
      }),
    ).toBe(true);
  });

  it('accepts a record with both level and pattern', () => {
    expect(
      validateSettingValue('capture.filters', {
        console: { level: ['error'], pattern: { include: ['boom'] } },
      }),
    ).toBe(true);
  });

  it('accepts an empty inner filter spec (no constraints)', () => {
    expect(
      validateSettingValue('capture.filters', { console: {} }),
    ).toBe(true);
  });

  it('rejects unknown top-level CaptureKind', () => {
    expect(
      validateSettingValue('capture.filters', {
        'not-a-kind': { level: ['error'] },
      }),
    ).toBe(false);
  });

  it('rejects level with unknown ConsoleLevel string', () => {
    expect(
      validateSettingValue('capture.filters', {
        console: { level: ['nonexistent'] },
      }),
    ).toBe(false);
  });

  it('rejects level as non-array', () => {
    expect(
      validateSettingValue('capture.filters', {
        console: { level: 'error' },
      }),
    ).toBe(false);
  });

  it('rejects pattern.include with non-string element', () => {
    expect(
      validateSettingValue('capture.filters', {
        console: { pattern: { include: ['ok', 42] } },
      }),
    ).toBe(false);
  });

  it('rejects pattern as non-object', () => {
    expect(
      validateSettingValue('capture.filters', {
        console: { pattern: 'boom' },
      }),
    ).toBe(false);
  });

  it('rejects extraneous FilterSpec keys at source (cursors/limit not applicable)', () => {
    expect(
      validateSettingValue('capture.filters', {
        console: { level: ['error'], limit: 10 },
      }),
    ).toBe(false);
    expect(
      validateSettingValue('capture.filters', {
        console: { since: 'somecursor' },
      }),
    ).toBe(false);
    expect(
      validateSettingValue('capture.filters', {
        console: { selectors: ['#root'] },
      }),
    ).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateSettingValue('capture.filters', null)).toBe(false);
    expect(validateSettingValue('capture.filters', [])).toBe(false);
    expect(validateSettingValue('capture.filters', 'no')).toBe(false);
  });
});

describe('validateSettingValue — capture.enabledKinds (enum[])', () => {
  it('accepts the empty subset and any unique subset of CAPTURE_KINDS', () => {
    expect(validateSettingValue('capture.enabledKinds', [])).toBe(true);
    expect(validateSettingValue('capture.enabledKinds', ['console'])).toBe(true);
    expect(validateSettingValue('capture.enabledKinds', ['console', 'network'])).toBe(true);
    expect(
      validateSettingValue('capture.enabledKinds', ['console', 'network', 'dom_mutations', 'lifecycle', 'store_change', 'replay']),
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
    expect(d['capture.enabledKinds']).toEqual(['console', 'network', 'dom_mutations', 'lifecycle', 'store_change', 'replay', 'library_popup']);
    expect(d['sites.readControls']).toEqual({});
    expect(d['capture.filters']).toEqual({});
    expect(d['capture.stores.allowDispatch']).toBe(false);
    expect(d['capture.sourceMap.enabled']).toBe(true);
  });

  it('returns array and object defaults as fresh clones, not aliases of the schema', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    expect(a['sites.allowlist']).not.toBe(b['sites.allowlist']);
    expect(a['capture.enabledKinds']).not.toBe(b['capture.enabledKinds']);
    expect(a['sites.readControls']).not.toBe(b['sites.readControls']);
    expect(a['capture.filters']).not.toBe(b['capture.filters']);
    // Schema arrays/objects themselves are not aliased into the result either:
    expect(a['sites.allowlist']).not.toBe(getSettingEntry('sites.allowlist').default);
    expect(a['sites.readControls']).not.toBe(getSettingEntry('sites.readControls').default);
    expect(a['capture.filters']).not.toBe(getSettingEntry('capture.filters').default);
  });

  it('every produced value passes its key validator', () => {
    const d = defaultSettings();
    for (const k of settingKeys()) {
      expect(validateSettingValue(k, d[k])).toBe(true);
    }
  });
});
