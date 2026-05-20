import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSettings,
  encodeCursor,
  decodeCursor,
  type Cursor,
  type SettingKey,
  type SettingTypeMap,
  type SettingsRecord,
} from '@pwa-debug/shared';
import { createRingBuffer } from '../../src/host_buffers/host_buffers.js';
import { createArchiveWriter } from '../../src/host_archive/host_archive.js';
import {
  tailWithFilterMerged,
  type TailMergedInput,
} from '../../src/captures_query/captures_query.js';
import type { HostStoredEvent } from '../../src/captures_in/captures_in.js';

// =====================================================================
// Fixtures
// =====================================================================

let dir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-merge-'));
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

const mkEvent = (
  sessionId: string,
  seq: number,
  extras: Record<string, unknown> = {},
): HostStoredEvent => ({
  ts: 1_000_000 + seq,
  receivedAt: 2_000_000 + seq,
  sessionId,
  extensionId: 'ext-test',
  kind: 'console',
  sequenceNumber: seq,
  ...extras,
});

/** Write `count` synthetic entries for (sessionId, kind) directly to disk. */
const seedDisk = async (
  sessionId: string,
  kind: 'console' | 'network',
  count: number,
  extras?: (seq: number) => Record<string, unknown>,
): Promise<void> => {
  const getSetting = makeGetSetting({
    'capture.diskSpill.enabled': true,
    'capture.diskSpill.maxBytes': 10_000_000,
  });
  let tick = 0;
  const w = createArchiveWriter({
    sessionId,
    getSetting,
    now: () => ++tick * 1000,
  });
  for (let i = 1; i <= count; i++) {
    await w.write(kind, mkEvent(sessionId, i, extras?.(i)));
  }
};

const seqs = (entries: readonly { sequenceNumber: number }[]): number[] =>
  entries.map((e) => e.sequenceNumber);

const emptyBuffer = () => createRingBuffer<HostStoredEvent>({ capacity: 100 });

// =====================================================================
// Routing — prior-session pure-disk read
// =====================================================================

describe('tailWithFilterMerged — prior-session routing (disk only)', () => {
  it('returns disk entries from a prior session when since.sessionId !== currentSessionId', async () => {
    await seedDisk('SESSION-A', 'console', 30);
    const buffer = emptyBuffer();
    const since = encodeCursor({
      sessionId: 'SESSION-A',
      sequenceNumber: 10,
    });
    const res = await tailWithFilterMerged({
      buffer,
      spec: { since },
      ctx: { currentSessionId: 'SESSION-B' },
      kind: 'console',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seqs(res.entries)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 11),
    );
    // Cursor must encode against the PRIOR session id.
    const decoded = decodeCursor(res.cursor as string);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.sessionId).toBe('SESSION-A');
      expect(decoded.value.sequenceNumber).toBe(30);
    }
    expect(res.hasMore).toBe(false);
  });

  it('applies the level filter to disk entries', async () => {
    await seedDisk('SESSION-A', 'console', 10, (seq) => ({
      level: seq % 2 === 0 ? 'error' : 'log',
    }));
    const since = encodeCursor({ sessionId: 'SESSION-A', sequenceNumber: 0 });
    const res = await tailWithFilterMerged({
      buffer: emptyBuffer(),
      spec: { since, level: ['error'] },
      ctx: { currentSessionId: 'SESSION-B' },
      kind: 'console',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seqs(res.entries)).toEqual([2, 4, 6, 8, 10]);
  });

  it('applies pattern include/exclude regex to disk entries', async () => {
    await seedDisk('SESSION-A', 'console', 6, (seq) => ({
      message: seq <= 3 ? 'hello world' : 'goodbye world',
    }));
    const since = encodeCursor({ sessionId: 'SESSION-A', sequenceNumber: 0 });
    const res = await tailWithFilterMerged({
      buffer: emptyBuffer(),
      spec: { since, pattern: { include: ['hello'] } },
      ctx: { currentSessionId: 'SESSION-B' },
      kind: 'console',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seqs(res.entries)).toEqual([1, 2, 3]);
  });

  it('truncates at limit and sets hasMore=true with the right cursor', async () => {
    await seedDisk('SESSION-A', 'console', 20);
    const since = encodeCursor({ sessionId: 'SESSION-A', sequenceNumber: 0 });
    const res = await tailWithFilterMerged({
      buffer: emptyBuffer(),
      spec: { since, limit: 5 },
      ctx: { currentSessionId: 'SESSION-B' },
      kind: 'console',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seqs(res.entries)).toEqual([1, 2, 3, 4, 5]);
    expect(res.hasMore).toBe(true);
    const decoded = decodeCursor(res.cursor as string);
    expect(decoded.ok && decoded.value.sequenceNumber).toBe(5);
  });

  it('empty result (no disk archive for that session) returns ok with empty entries', async () => {
    const since = encodeCursor({ sessionId: 'NEVER-EXISTED', sequenceNumber: 0 });
    const res = await tailWithFilterMerged({
      buffer: emptyBuffer(),
      spec: { since },
      ctx: { currentSessionId: 'CURRENT' },
      kind: 'console',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries).toEqual([]);
    expect(res.cursor).toBeNull();
    expect(res.hasMore).toBe(false);
  });
});

// =====================================================================
// Routing — current-session merge (disk gap + memory)
// =====================================================================

describe('tailWithFilterMerged — current-session merge (disk + memory)', () => {
  it('concatenates disk slice + memory slice in seq order across the eviction boundary', async () => {
    // Disk has seqs 1..5 (evicted long ago); memory has seqs 6..10.
    await seedDisk('SESSION-A', 'console', 5);
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 5 });
    for (let i = 6; i <= 10; i++) buffer.push(mkEvent('SESSION-A', i));

    const since = encodeCursor({
      sessionId: 'SESSION-A',
      sequenceNumber: 0,
    });
    const res = await tailWithFilterMerged({
      buffer,
      spec: { since },
      ctx: { currentSessionId: 'SESSION-A' },
      kind: 'console',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seqs(res.entries)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const decoded = decodeCursor(res.cursor as string);
    expect(decoded.ok && decoded.value.sessionId).toBe('SESSION-A');
    expect(decoded.ok && decoded.value.sequenceNumber).toBe(10);
    expect(res.hasMore).toBe(false);
  });

  it('disk-only when it already fills the limit; memory is not consulted', async () => {
    await seedDisk('SESSION-A', 'console', 20);
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 5 });
    for (let i = 100; i < 105; i++) buffer.push(mkEvent('SESSION-A', i));

    const since = encodeCursor({
      sessionId: 'SESSION-A',
      sequenceNumber: 0,
    });
    const res = await tailWithFilterMerged({
      buffer,
      spec: { since, limit: 5 },
      ctx: { currentSessionId: 'SESSION-A' },
      kind: 'console',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seqs(res.entries)).toEqual([1, 2, 3, 4, 5]);
    expect(res.hasMore).toBe(true);
  });
});

// =====================================================================
// No-since path — memory-only delegation
// =====================================================================

describe('tailWithFilterMerged — no since cursor', () => {
  it('delegates to tailWithFilter (memory-only "latest" semantics, no disk touch)', async () => {
    // Seed disk to PROVE it is not consulted.
    await seedDisk('SESSION-A', 'console', 5);
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 10 });
    for (let i = 100; i < 103; i++) buffer.push(mkEvent('SESSION-A', i));

    const res = await tailWithFilterMerged({
      buffer,
      spec: undefined,
      ctx: { currentSessionId: 'SESSION-A' },
      kind: 'console',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seqs(res.entries)).toEqual([100, 101, 102]);
  });
});

// =====================================================================
// Error mapping
// =====================================================================

describe('tailWithFilterMerged — error mapping', () => {
  it('cursor_invalid: malformed since cursor → error (no disk consulted)', async () => {
    let diskCalls = 0;
    const fakeReadDisk = async () => {
      diskCalls += 1;
      return { entries: [], hasMore: false };
    };
    const res = await tailWithFilterMerged({
      buffer: emptyBuffer(),
      spec: { since: 'not-base64-at-all' as Cursor },
      ctx: { currentSessionId: 'X' },
      kind: 'console',
      readDisk: fakeReadDisk,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('cursor_invalid');
    expect(res.error.fieldPath).toBe('since');
    expect(diskCalls).toBe(0);
  });

  it('cursor_session_mismatch: until session differs from since session → error', async () => {
    const since = encodeCursor({
      sessionId: 'PRIOR',
      sequenceNumber: 0,
    });
    const until = encodeCursor({
      sessionId: 'OTHER',
      sequenceNumber: 100,
    });
    const res = await tailWithFilterMerged({
      buffer: emptyBuffer(),
      spec: { since, until },
      ctx: { currentSessionId: 'CURRENT' },
      kind: 'console',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('cursor_session_mismatch');
    if (res.error.kind === 'cursor_session_mismatch') {
      expect(res.error.fieldPath).toBe('until');
      expect(res.error.cursorSessionId).toBe('OTHER');
      expect(res.error.currentSessionId).toBe('PRIOR');
    }
  });
});

// =====================================================================
// Injectable readDisk
// =====================================================================

describe('tailWithFilterMerged — injectable readDisk', () => {
  it('uses the supplied readDisk and ignores host_archive for testability', async () => {
    let observed: { sessionId?: string; sinceSeq?: number; kind?: string } = {};
    const fakeReadDisk: TailMergedInput<HostStoredEvent>['readDisk'] = async (
      input,
    ) => {
      observed = {
        sessionId: input.sessionId,
        sinceSeq: input.sinceSeq,
        kind: input.kind,
      };
      return {
        entries: [
          mkEvent(input.sessionId, 99, { source: 'fake' }),
          mkEvent(input.sessionId, 100, { source: 'fake' }),
        ],
        hasMore: false,
      };
    };
    const since = encodeCursor({
      sessionId: 'INJECTED',
      sequenceNumber: 42,
    });
    const res = await tailWithFilterMerged({
      buffer: emptyBuffer(),
      spec: { since },
      ctx: { currentSessionId: 'CURRENT' },
      kind: 'network',
      readDisk: fakeReadDisk,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seqs(res.entries)).toEqual([99, 100]);
    expect(observed).toMatchObject({
      sessionId: 'INJECTED',
      sinceSeq: 42,
      kind: 'network',
    });
  });
});
