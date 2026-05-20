import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSettings,
  type SettingKey,
  type SettingTypeMap,
  type SettingsRecord,
} from '@pwa-debug/shared';
import { appendLine } from '../../src/host_io/host_io.js';
import {
  createArchiveWriter,
  listArchiveFiles,
  parseArchiveLine,
  readArchive,
  resolveArchiveDir,
  resolveArchivePath,
} from '../../src/host_archive/host_archive.js';

// =====================================================================
// Fixtures
// =====================================================================

let dir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-host-archive-read-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(dir, { recursive: true, force: true });
});

const makeGetSetting = (overrides: Partial<SettingsRecord> = {}) => {
  const record: Record<string, unknown> = {
    ...defaultSettings(),
    ...overrides,
  };
  return <K extends SettingKey>(key: K): SettingTypeMap[K] =>
    record[key] as SettingTypeMap[K];
};

const mockEntry = (n: number) => ({
  sequenceNumber: n,
  ts: 1_000_000 + n,
  receivedAt: 2_000_000 + n,
  sessionId: 'sess1',
  extensionId: 'ext1',
  kind: 'console_log',
  payload: { msg: `n=${n}` },
});

const seqs = (entries: readonly { sequenceNumber: number }[]): number[] =>
  entries.map((e) => e.sequenceNumber);

// =====================================================================
// parseArchiveLine — pure decoder
// =====================================================================

describe('parseArchiveLine', () => {
  it('decodes a valid jsonl line with numeric sequenceNumber', () => {
    const e = mockEntry(7);
    expect(parseArchiveLine(JSON.stringify(e))).toEqual({ ok: true, value: e });
  });
  it('rejects malformed json', () => {
    expect(parseArchiveLine('not-json')).toEqual({ ok: false });
    expect(parseArchiveLine('{"truncated":')).toEqual({ ok: false });
  });
  it('rejects empty line', () => {
    expect(parseArchiveLine('')).toEqual({ ok: false });
  });
  it('rejects non-object roots', () => {
    expect(parseArchiveLine('null')).toEqual({ ok: false });
    expect(parseArchiveLine('"a"')).toEqual({ ok: false });
    expect(parseArchiveLine('42')).toEqual({ ok: false });
    expect(parseArchiveLine('[1,2,3]')).toEqual({ ok: false });
  });
  it('rejects entries with missing / non-numeric sequenceNumber', () => {
    expect(parseArchiveLine('{"a":1}')).toEqual({ ok: false });
    expect(parseArchiveLine('{"sequenceNumber":"7"}')).toEqual({ ok: false });
    expect(parseArchiveLine('{"sequenceNumber":null}')).toEqual({ ok: false });
    expect(parseArchiveLine('{"sequenceNumber":1.5e308000}')).toEqual({
      ok: false,
    });
  });
});

// =====================================================================
// listArchiveFiles — pure-at-edges enumeration
// =====================================================================

describe('listArchiveFiles', () => {
  it('returns [] when the kind directory is missing', async () => {
    expect(await listArchiveFiles('nope', 'console')).toEqual([]);
  });

  it('returns only jsonl files with numeric stems, sorted ascending', async () => {
    const kindDir = resolveArchiveDir('s', 'console');
    await appendLine(`${kindDir}/200.jsonl`, '{"sequenceNumber":2}');
    await appendLine(`${kindDir}/100.jsonl`, '{"sequenceNumber":1}');
    await appendLine(`${kindDir}/300.jsonl`, '{"sequenceNumber":3}');
    await appendLine(`${kindDir}/readme.txt`, 'noise');
    await appendLine(`${kindDir}/abc.jsonl`, 'noise');
    expect(await listArchiveFiles('s', 'console')).toEqual([
      resolveArchivePath('s', 'console', 100),
      resolveArchivePath('s', 'console', 200),
      resolveArchivePath('s', 'console', 300),
    ]);
  });
});

// =====================================================================
// readArchive — end-to-end via T1 writer
// =====================================================================

const writeRange = async (
  sessionId: string,
  kind: 'console' | 'network',
  count: number,
  opts: { maxBytes: number; now: () => number },
) => {
  const getSetting = makeGetSetting({
    'capture.diskSpill.enabled': true,
    'capture.diskSpill.maxBytes': opts.maxBytes,
  });
  const w = createArchiveWriter({
    sessionId,
    getSetting,
    now: opts.now,
  });
  for (let i = 1; i <= count; i++) {
    await w.write(kind, mockEntry(i));
  }
};

describe('readArchive — round-trip via T1 writer', () => {
  it('reads 30 entries in seq order across rotated files', async () => {
    let tick = 0;
    await writeRange('sess1', 'console', 30, {
      maxBytes: 1200, // → cap = 300, ~30-byte entries → ~10 entries/file
      now: () => ++tick * 100,
    });
    const result = await readArchive({ sessionId: 'sess1', kind: 'console' });
    expect(result.hasMore).toBe(false);
    expect(seqs(result.entries)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect((await listArchiveFiles('sess1', 'console')).length).toBeGreaterThan(
      1,
    );
  });
});

// =====================================================================
// readArchive — cursor bounds
// =====================================================================

describe('readArchive — cursor bounds', () => {
  const setup30 = async () => {
    let tick = 0;
    await writeRange('s', 'console', 30, {
      maxBytes: 1200,
      now: () => ++tick * 100,
    });
  };

  it('sinceSeq is exclusive — drops entries with seq <= sinceSeq', async () => {
    await setup30();
    const res = await readArchive({
      sessionId: 's',
      kind: 'console',
      sinceSeq: 15,
    });
    expect(seqs(res.entries)).toEqual([
      16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
    expect(res.hasMore).toBe(false);
  });

  it('untilSeq is exclusive — drops entries with seq >= untilSeq', async () => {
    await setup30();
    const res = await readArchive({
      sessionId: 's',
      kind: 'console',
      untilSeq: 20,
    });
    expect(seqs(res.entries)).toEqual(
      Array.from({ length: 19 }, (_, i) => i + 1),
    );
    expect(res.hasMore).toBe(false);
  });

  it('combines sinceSeq + untilSeq into a narrow window', async () => {
    await setup30();
    const res = await readArchive({
      sessionId: 's',
      kind: 'console',
      sinceSeq: 10,
      untilSeq: 15,
    });
    expect(seqs(res.entries)).toEqual([11, 12, 13, 14]);
    expect(res.hasMore).toBe(false);
  });
});

// =====================================================================
// readArchive — limit + hasMore
// =====================================================================

describe('readArchive — limit + hasMore', () => {
  it('truncates at limit and sets hasMore=true', async () => {
    let tick = 0;
    await writeRange('s', 'console', 30, {
      maxBytes: 1200,
      now: () => ++tick * 100,
    });
    const res = await readArchive({
      sessionId: 's',
      kind: 'console',
      limit: 10,
    });
    expect(res.entries.length).toBe(10);
    expect(seqs(res.entries)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(res.hasMore).toBe(true);
  });

  it('default limit (no truncation needed) reports hasMore=false', async () => {
    let tick = 0;
    await writeRange('s', 'console', 30, {
      maxBytes: 1200,
      now: () => ++tick * 100,
    });
    const res = await readArchive({ sessionId: 's', kind: 'console' });
    expect(res.hasMore).toBe(false);
  });

  it('clamps a degenerate non-positive limit back to the default', async () => {
    let tick = 0;
    await writeRange('s', 'console', 30, {
      maxBytes: 1200,
      now: () => ++tick * 100,
    });
    const res = await readArchive({
      sessionId: 's',
      kind: 'console',
      limit: 0,
    });
    expect(res.entries.length).toBe(30);
    expect(res.hasMore).toBe(false);
  });
});

// =====================================================================
// readArchive — robustness
// =====================================================================

describe('readArchive — robustness', () => {
  it('returns empty for a kind that was never written (no throw)', async () => {
    const res = await readArchive({
      sessionId: 'fresh',
      kind: 'dom_mutations',
    });
    expect(res).toEqual({ entries: [], hasMore: false });
  });

  it('skips malformed lines and continues the read', async () => {
    await writeRange('s', 'console', 2, {
      maxBytes: 1_000_000, // no rotation
      now: () => 100,
    });
    // Manually inject two malformed lines into the same archive file.
    const path = resolveArchivePath('s', 'console', 100);
    await appendLine(path, 'NOT-JSON');
    await appendLine(path, '{"no":"seq"}');
    await writeRange('s', 'console', 0, {
      maxBytes: 1_000_000,
      now: () => 100,
    });
    // Add one more good entry to confirm read continues across the garbage.
    await writeRange('s', 'console', 3, {
      maxBytes: 1_000_000,
      now: () => 100,
    });
    const res = await readArchive({ sessionId: 's', kind: 'console' });
    // 'console' has writes (1,2) and then (1,2,3) due to writeRange semantics;
    // the deduplicated seq sequence we expect: [1,2,1,2,3] — readArchive is
    // FIFO across the file's appended lines, malformed lines skipped.
    expect(seqs(res.entries)).toEqual([1, 2, 1, 2, 3]);
    expect(res.hasMore).toBe(false);
  });

  it('isolates kinds — console reader never sees network entries', async () => {
    const getSetting = makeGetSetting({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 1_000_000,
    });
    const w = createArchiveWriter({
      sessionId: 's',
      getSetting,
      now: () => 100,
    });
    await w.write('console', mockEntry(1));
    await w.write('network', mockEntry(2));
    await w.write('console', mockEntry(3));
    const consoleRes = await readArchive({ sessionId: 's', kind: 'console' });
    expect(seqs(consoleRes.entries)).toEqual([1, 3]);
    const netRes = await readArchive({ sessionId: 's', kind: 'network' });
    expect(seqs(netRes.entries)).toEqual([2]);
  });
});
