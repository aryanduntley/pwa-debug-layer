import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSettings,
  type SettingKey,
  type SettingTypeMap,
  type SettingsRecord,
} from '@pwa-debug/shared';
import {
  createArchiveWriter,
  resolveArchivePath,
  shouldRotate,
} from '../../src/host_archive/host_archive.js';

// =====================================================================
// Test fixtures
// =====================================================================

let dir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-host-archive-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(dir, { recursive: true, force: true });
});

/**
 * Closure-backed mutable settings record. getSetting reads it live, so flipping
 * a key between writes exercises the writer's no-cache contract.
 */
const makeMutableSettings = (overrides: Partial<SettingsRecord> = {}) => {
  const record: Record<string, unknown> = {
    ...defaultSettings(),
    ...overrides,
  };
  const getSetting = <K extends SettingKey>(key: K): SettingTypeMap[K] =>
    record[key] as SettingTypeMap[K];
  const set = <K extends SettingKey>(
    key: K,
    value: SettingTypeMap[K],
  ): void => {
    record[key] = value;
  };
  return { getSetting, set };
};

/** Deterministic monotonic clock so rotation timestamps are predictable. */
const tickingClock = (start = 1) => {
  let n = start;
  return () => n++;
};

// =====================================================================
// Pure helpers
// =====================================================================

describe('resolveArchivePath', () => {
  it('composes <XDG_CONFIG_HOME>/pwa-debug/buffers/<session>/<kind>/<ts>.jsonl', () => {
    const p = resolveArchivePath('sess-abc', 'console', 123);
    expect(p).toBe(join(dir, 'pwa-debug', 'buffers', 'sess-abc', 'console', '123.jsonl'));
  });

  it('isolates kinds into separate subdirectories', () => {
    const a = resolveArchivePath('s', 'console', 1);
    const b = resolveArchivePath('s', 'network', 1);
    expect(a).not.toBe(b);
    expect(a).toContain('/console/');
    expect(b).toContain('/network/');
  });
});

describe('shouldRotate', () => {
  it('returns false when next write fits exactly', () => {
    expect(shouldRotate(6, 4, 10)).toBe(false);
  });
  it('returns true when next write would exceed cap', () => {
    expect(shouldRotate(6, 5, 10)).toBe(true);
  });
  it('handles empty file correctly (currentBytes=0)', () => {
    expect(shouldRotate(0, 10, 10)).toBe(false);
    expect(shouldRotate(0, 11, 10)).toBe(true);
  });
});

// =====================================================================
// createArchiveWriter — round-trip, rotation, gating
// =====================================================================

describe('createArchiveWriter — round-trip', () => {
  it('writes one record as one jsonl line that round-trips to the original entry', async () => {
    const { getSetting } = makeMutableSettings({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 1_000_000,
    });
    const w = createArchiveWriter({
      sessionId: 'sess1',
      getSetting,
      now: tickingClock(1000),
    });
    const entry = { ts: 42, msg: 'hello', n: 7 };
    await w.write('console', entry);
    const path = join(dir, 'pwa-debug', 'buffers', 'sess1', 'console', '1000.jsonl');
    const body = await readFile(path, 'utf-8');
    expect(body).toBe(`${JSON.stringify(entry)}\n`);
    expect(w.getStats()).toEqual({ writeCount: 1, dropCount: 0 });
  });

  it('appends multiple records into the same file when under the per-file cap', async () => {
    const { getSetting } = makeMutableSettings({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 1_000_000,
    });
    const w = createArchiveWriter({
      sessionId: 'sess1',
      getSetting,
      now: tickingClock(1000),
    });
    await w.write('console', { ts: 1 });
    await w.write('console', { ts: 2 });
    await w.write('console', { ts: 3 });
    const path = join(dir, 'pwa-debug', 'buffers', 'sess1', 'console', '1000.jsonl');
    const lines = (await readFile(path, 'utf-8')).split('\n').filter(Boolean);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { ts: 1 },
      { ts: 2 },
      { ts: 3 },
    ]);
    expect(w.getStats().writeCount).toBe(3);
  });
});

describe('createArchiveWriter — rotation', () => {
  it('rotates to a fresh file when the next write would push past maxBytes/4', async () => {
    // maxBytes=80 → cap = floor(80/4) = 20.
    // {"ts":1} stringified = 8 bytes + 1 newline = 9 bytes per write.
    // Bytes after writes: 9, 18, then 18+9=27 > 20 → rotate before write #3.
    const { getSetting } = makeMutableSettings({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 80,
    });
    const w = createArchiveWriter({
      sessionId: 'sess1',
      getSetting,
      now: tickingClock(100),
    });
    await w.write('console', { ts: 1 });
    await w.write('console', { ts: 2 });
    await w.write('console', { ts: 3 });
    const kindDir = join(dir, 'pwa-debug', 'buffers', 'sess1', 'console');
    const files = (await readdir(kindDir)).sort();
    // tickingClock starts at 100; clock advances ONLY on rotation, so
    // write #1 opens 100.jsonl, write #2 stays in 100.jsonl (no rotate),
    // write #3 rotates and opens 101.jsonl.
    expect(files).toEqual(['100.jsonl', '101.jsonl']);
    const first = await readFile(join(kindDir, '100.jsonl'), 'utf-8');
    const second = await readFile(join(kindDir, '101.jsonl'), 'utf-8');
    expect(first.split('\n').filter(Boolean).map((l) => JSON.parse(l))).toEqual([
      { ts: 1 },
      { ts: 2 },
    ]);
    expect(second.split('\n').filter(Boolean).map((l) => JSON.parse(l))).toEqual([
      { ts: 3 },
    ]);
  });

  it('clamps a degenerate maxBytes setting to a minimum per-file cap (no throw)', async () => {
    // maxBytes=0 → cap clamped to 1; every write rotates.
    const { getSetting } = makeMutableSettings({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 0,
    });
    const w = createArchiveWriter({
      sessionId: 'sess1',
      getSetting,
      now: tickingClock(1),
    });
    await w.write('console', { ts: 1 });
    await w.write('console', { ts: 2 });
    const kindDir = join(dir, 'pwa-debug', 'buffers', 'sess1', 'console');
    const files = (await readdir(kindDir)).sort();
    expect(files).toEqual(['1.jsonl', '2.jsonl']);
  });
});

describe('createArchiveWriter — live gating on capture.diskSpill.enabled', () => {
  it('drops writes (no file activity) when enabled=false', async () => {
    const { getSetting } = makeMutableSettings({
      'capture.diskSpill.enabled': false,
      'capture.diskSpill.maxBytes': 1_000_000,
    });
    const w = createArchiveWriter({
      sessionId: 'sess1',
      getSetting,
      now: tickingClock(1),
    });
    await w.write('console', { ts: 1 });
    await w.write('console', { ts: 2 });
    const buffersDir = join(dir, 'pwa-debug', 'buffers');
    // No directories created (no fs activity at all from the writer).
    await expect(readdir(buffersDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(w.getStats()).toEqual({ writeCount: 0, dropCount: 2 });
  });

  it('respects a LIVE flip of enabled between writes (no restart, no cache)', async () => {
    const { getSetting, set } = makeMutableSettings({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 1_000_000,
    });
    const w = createArchiveWriter({
      sessionId: 'sess1',
      getSetting,
      now: tickingClock(1),
    });
    await w.write('console', { ts: 1 });
    await w.write('console', { ts: 2 });
    await w.write('console', { ts: 3 });
    set('capture.diskSpill.enabled', false);
    await w.write('console', { ts: 4 });
    await w.write('console', { ts: 5 });
    await w.write('console', { ts: 6 });
    const path = join(dir, 'pwa-debug', 'buffers', 'sess1', 'console', '1.jsonl');
    const lines = (await readFile(path, 'utf-8')).split('\n').filter(Boolean);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { ts: 1 },
      { ts: 2 },
      { ts: 3 },
    ]);
    expect(w.getStats()).toEqual({ writeCount: 3, dropCount: 3 });
  });
});

describe('createArchiveWriter — per-kind isolation', () => {
  it('routes different kinds into distinct path subtrees and counters', async () => {
    const { getSetting } = makeMutableSettings({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 1_000_000,
    });
    const w = createArchiveWriter({
      sessionId: 'sess1',
      getSetting,
      now: tickingClock(10),
    });
    await w.write('console', { ts: 1 });
    await w.write('network', { ts: 2 });
    await w.write('console', { ts: 3 });
    const sessDir = join(dir, 'pwa-debug', 'buffers', 'sess1');
    const subdirs = (await readdir(sessDir)).sort();
    expect(subdirs).toEqual(['console', 'network']);
    const consoleLines = (
      await readFile(join(sessDir, 'console', '10.jsonl'), 'utf-8')
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // tickingClock(10): console write#1 → 10.jsonl; network write#2 first-open
    // for the 'network' kind, so it pulls the next tick = 11.jsonl.
    const networkLines = (
      await readFile(join(sessDir, 'network', '11.jsonl'), 'utf-8')
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(consoleLines).toEqual([{ ts: 1 }, { ts: 3 }]);
    expect(networkLines).toEqual([{ ts: 2 }]);
  });
});

describe('createArchiveWriter — frozen surface', () => {
  it('returns a frozen bag and frozen stats snapshot', () => {
    const { getSetting } = makeMutableSettings({});
    const w = createArchiveWriter({ sessionId: 's', getSetting });
    expect(Object.isFrozen(w)).toBe(true);
    expect(Object.isFrozen(w.getStats())).toBe(true);
  });
});
