import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSettings,
  type CaptureKind,
  type SettingChange,
  type SettingsRecord,
} from '@pwa-debug/shared';
import {
  createSettingsStore,
  diffChangedKeys,
  mergeOverDefaults,
  parsePersistedSettings,
  type SettingsStore,
  type SettingsStoreOptions,
} from '../../src/host_settings/host_settings.js';

let dir: string;
let path: string;
let stores: SettingsStore[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-settings-'));
  path = join(dir, 'settings.json');
  stores = [];
});
afterEach(async () => {
  for (const s of stores) s.dispose();
  await rm(dir, { recursive: true, force: true });
});

const make = (opts: SettingsStoreOptions = {}): SettingsStore => {
  const s = createSettingsStore({ path, disableWatch: true, ...opts });
  stores.push(s);
  return s;
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 500,
  stepMs = 10,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(stepMs);
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
};

// =====================================================================
// Pure transforms
// =====================================================================

describe('parsePersistedSettings', () => {
  it('returns {} for non-object roots (null / array / string / number)', () => {
    expect(parsePersistedSettings(null)).toEqual({});
    expect(parsePersistedSettings([])).toEqual({});
    expect(parsePersistedSettings('hello')).toEqual({});
    expect(parsePersistedSettings(42)).toEqual({});
  });

  it('keeps schema-known keys whose values pass validation', () => {
    const got = parsePersistedSettings({
      'capture.memoryCutoffPerKind': 1234,
      'sites.allowlist': ['https://ok.com/*'],
    });
    expect(got).toEqual({
      'capture.memoryCutoffPerKind': 1234,
      'sites.allowlist': ['https://ok.com/*'],
    });
  });

  it('silently drops invalid values (mergeOverDefaults will fill with defaults)', () => {
    const got = parsePersistedSettings({
      'capture.memoryCutoffPerKind': -1, // negative -> invalid
      'capture.diskSpill.enabled': 'yes', // string -> invalid
      'sites.allowlist': 'not-an-array',
      'capture.enabledKinds': ['console', 'unknown-kind'],
    });
    expect(got).toEqual({});
  });

  it('silently drops unknown persisted keys (forward-compat with older host versions)', () => {
    const got = parsePersistedSettings({
      'capture.memoryCutoffPerKind': 100,
      'ui.someFutureKey': 'whatever',
      'old.deprecated': 42,
    });
    expect(got).toEqual({ 'capture.memoryCutoffPerKind': 100 });
  });
});

describe('mergeOverDefaults', () => {
  it('returns defaultSettings() for an empty partial', () => {
    expect(mergeOverDefaults({})).toEqual(defaultSettings());
  });

  it('overlays persisted values onto defaults', () => {
    const merged = mergeOverDefaults({
      'capture.memoryCutoffPerKind': 9999,
      'capture.diskSpill.enabled': true,
    });
    expect(merged['capture.memoryCutoffPerKind']).toBe(9999);
    expect(merged['capture.diskSpill.enabled']).toBe(true);
    // unchanged keys retain defaults
    expect(merged['capture.diskSpill.archiveLongevityDays']).toBe(7);
    expect(merged['sites.allowlist']).toEqual(['*']);
  });

  it('defensively re-validates: invalid persisted values fall back to defaults', () => {
    const merged = mergeOverDefaults({
      // simulate a TS-bypass that snuck an invalid value past parsePersistedSettings
      'capture.memoryCutoffPerKind': -5 as unknown as number,
    });
    expect(merged['capture.memoryCutoffPerKind']).toBe(5000); // default
  });

  it('result contains every SettingKey (no gaps)', () => {
    const merged = mergeOverDefaults({});
    const defaults = defaultSettings();
    expect(Object.keys(merged).sort()).toEqual(Object.keys(defaults).sort());
  });
});

describe('diffChangedKeys', () => {
  it('returns [] for identical records', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    expect(diffChangedKeys(a, b)).toEqual([]);
  });

  it('detects a single primitive change', () => {
    const a = defaultSettings();
    const b: SettingsRecord = { ...a, 'capture.memoryCutoffPerKind': 1 };
    expect(diffChangedKeys(a, b)).toEqual(['capture.memoryCutoffPerKind']);
  });

  it('detects array-element changes (element-wise compare)', () => {
    const a = defaultSettings();
    const b: SettingsRecord = { ...a, 'sites.allowlist': ['*', 'extra.com/*'] };
    expect(diffChangedKeys(a, b)).toEqual(['sites.allowlist']);
  });

  it('returns changed keys in schema-declaration order', () => {
    const a = defaultSettings();
    const b: SettingsRecord = {
      ...a,
      'capture.enabledKinds': [],
      'capture.memoryCutoffPerKind': 1,
    };
    expect(diffChangedKeys(a, b)).toEqual([
      'capture.memoryCutoffPerKind',
      'capture.enabledKinds',
    ]);
  });
});

// =====================================================================
// Store — basics (disableWatch:true)
// =====================================================================

describe('createSettingsStore — basics', () => {
  it('getSetting returns schema defaults pre-init (tolerant of init ordering)', () => {
    const s = make();
    expect(s.getSetting('capture.memoryCutoffPerKind')).toBe(5000);
    expect(s.getSetting('sites.allowlist')).toEqual(['*']);
  });

  it('init() with no persisted file yields all defaults', async () => {
    const s = make();
    await s.init();
    expect(s.getAll()).toEqual(defaultSettings());
  });

  it('init() reads a valid persisted file and overlays it', async () => {
    await writeFile(
      path,
      JSON.stringify({
        'capture.memoryCutoffPerKind': 2500,
        'sites.blocklist': ['*.tracking.com'],
      }),
      'utf-8',
    );
    const s = make();
    await s.init();
    expect(s.getSetting('capture.memoryCutoffPerKind')).toBe(2500);
    expect(s.getSetting('sites.blocklist')).toEqual(['*.tracking.com']);
    // unset keys still at defaults
    expect(s.getSetting('capture.diskSpill.enabled')).toBe(false);
  });

  it('init() with a malformed persisted file falls back to defaults gracefully (drops invalid)', async () => {
    await writeFile(
      path,
      JSON.stringify({
        'capture.memoryCutoffPerKind': 'not-a-number',
        'sites.allowlist': 42,
      }),
      'utf-8',
    );
    const s = make();
    await s.init();
    expect(s.getAll()).toEqual(defaultSettings());
  });

  it('setSetting persists and reads back via getSetting', async () => {
    const s = make();
    await s.init();
    const res = await s.setSetting('capture.memoryCutoffPerKind', 7777);
    expect(res).toEqual({ ok: true });
    expect(s.getSetting('capture.memoryCutoffPerKind')).toBe(7777);
    const onDisk = JSON.parse(await readFile(path, 'utf-8'));
    expect(onDisk['capture.memoryCutoffPerKind']).toBe(7777);
  });

  it('setSetting rejects an invalid value with a schema-contextualized error', async () => {
    const s = make();
    await s.init();
    const res = await s.setSetting(
      'capture.memoryCutoffPerKind',
      -1 as unknown as number,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("'capture.memoryCutoffPerKind'");
      expect(res.error).toContain('number');
    }
    expect(s.getSetting('capture.memoryCutoffPerKind')).toBe(5000); // unchanged
  });

  it('setSetting rejection does NOT write the file (no side effect)', async () => {
    const s = make();
    await s.init();
    await s.setSetting(
      'capture.enabledKinds',
      ['ooga'] as unknown as readonly CaptureKind[],
    );
    // file should not exist (init didn't create one, rejection didn't either)
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  it('setSetting rejection does NOT notify subscribers', async () => {
    const s = make();
    await s.init();
    const events: SettingChange[] = [];
    s.subscribe((c) => events.push(c));
    await s.setSetting(
      'capture.memoryCutoffPerKind',
      -1 as unknown as number,
    );
    expect(events).toEqual([]);
  });

  it('setSetting with the same value is an idempotent no-op (no notify, no rewrite)', async () => {
    const s = make();
    await s.init();
    await s.setSetting('capture.memoryCutoffPerKind', 7000); // primes the file
    const mtime1 = (await stat(path)).mtimeMs;
    await wait(20); // give the FS clock a tick so a real rewrite would show
    const events: SettingChange[] = [];
    s.subscribe((c) => events.push(c));
    const res = await s.setSetting('capture.memoryCutoffPerKind', 7000); // same value
    expect(res).toEqual({ ok: true });
    expect(events).toEqual([]); // no notify
    const mtime2 = (await stat(path)).mtimeMs;
    expect(mtime2).toBe(mtime1); // file not rewritten (atomic-rename would bump mtime)
  });

  it('subscribers receive a SettingChange on each accepted setSetting', async () => {
    const s = make();
    await s.init();
    const events: SettingChange[] = [];
    s.subscribe((c) => events.push(c));
    await s.setSetting('capture.memoryCutoffPerKind', 1234);
    await s.setSetting('capture.diskSpill.enabled', true);
    expect(events).toEqual([
      { key: 'capture.memoryCutoffPerKind', value: 1234 },
      { key: 'capture.diskSpill.enabled', value: true },
    ]);
  });

  it('multiple subscribers all fire; a throwing listener does not break the dispatch loop', async () => {
    const s = make();
    await s.init();
    const events1: SettingChange[] = [];
    const events2: SettingChange[] = [];
    s.subscribe(() => {
      throw new Error('boom');
    });
    s.subscribe((c) => events1.push(c));
    s.subscribe((c) => events2.push(c));
    await s.setSetting('capture.memoryCutoffPerKind', 42);
    expect(events1).toEqual([{ key: 'capture.memoryCutoffPerKind', value: 42 }]);
    expect(events2).toEqual([{ key: 'capture.memoryCutoffPerKind', value: 42 }]);
  });

  it('subscribe disposer removes the listener; dispose() is idempotent', async () => {
    const s = make();
    await s.init();
    const events: SettingChange[] = [];
    const unsub = s.subscribe((c) => events.push(c));
    await s.setSetting('capture.memoryCutoffPerKind', 1);
    unsub();
    await s.setSetting('capture.memoryCutoffPerKind', 2);
    expect(events).toEqual([{ key: 'capture.memoryCutoffPerKind', value: 1 }]);
    s.dispose();
    expect(() => s.dispose()).not.toThrow();
  });

  it('round-trip across a simulated host restart: store2 reads what store1 wrote', async () => {
    const s1 = make();
    await s1.init();
    await s1.setSetting('capture.memoryCutoffPerKind', 8888);
    await s1.setSetting('capture.diskSpill.enabled', true);
    s1.dispose();

    const s2 = make();
    await s2.init();
    expect(s2.getSetting('capture.memoryCutoffPerKind')).toBe(8888);
    expect(s2.getSetting('capture.diskSpill.enabled')).toBe(true);
    // unchanged keys retained their defaults across restart
    expect(s2.getSetting('sites.allowlist')).toEqual(['*']);
  });
});

// =====================================================================
// Store — watcher (disableWatch:false)
// =====================================================================

describe('createSettingsStore — fs.watch external-edit reload', () => {
  it('notifies subscribers when the file is edited externally', async () => {
    // Pre-seed the file so the watcher can attach during init().
    await writeFile(
      path,
      JSON.stringify({ 'capture.memoryCutoffPerKind': 5000 }),
      'utf-8',
    );
    const s = make({ disableWatch: false, watchDebounceMs: 10 });
    await s.init();
    const events: SettingChange[] = [];
    s.subscribe((c) => events.push(c));

    // External edit: a different writer changes the file in place.
    await writeFile(
      path,
      JSON.stringify({
        'capture.memoryCutoffPerKind': 6000,
        'capture.diskSpill.enabled': true,
      }),
      'utf-8',
    );

    await waitFor(() => events.length >= 2, 1000);
    const byKey = new Map(events.map((e) => [e.key, e]));
    expect(byKey.get('capture.memoryCutoffPerKind')).toEqual({
      key: 'capture.memoryCutoffPerKind',
      value: 6000,
    });
    expect(byKey.get('capture.diskSpill.enabled')).toEqual({
      key: 'capture.diskSpill.enabled',
      value: true,
    });
    expect(s.getSetting('capture.memoryCutoffPerKind')).toBe(6000);
  });

  it('does not spuriously re-notify on self-writes (mtime guard)', async () => {
    const s = make({ disableWatch: false, watchDebounceMs: 10 });
    await s.init();
    const events: SettingChange[] = [];
    s.subscribe((c) => events.push(c));

    await s.setSetting('capture.memoryCutoffPerKind', 12345);
    // Wait several debounce windows; if the watcher were going to spuriously
    // fire from our own write, it would have by now.
    await wait(150);

    expect(events).toEqual([{ key: 'capture.memoryCutoffPerKind', value: 12345 }]);
  });
});
