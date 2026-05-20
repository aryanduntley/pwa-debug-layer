import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
  bridgeWriterToOnEvict,
  createArchiveWriter,
  pruneArchives,
  pruneByAge,
  pruneBySize,
  resolveArchivePath,
  resolveBuffersBaseDir,
  scanArchiveFiles,
  type ArchiveFileMeta,
} from '../../src/host_archive/host_archive.js';

// =====================================================================
// Fixtures
// =====================================================================

let dir: string;
let prevXdg: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-host-archive-prune-'));
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

const meta = (
  path: string,
  mtimeMs: number,
  bytes: number,
): ArchiveFileMeta => ({
  path,
  sessionId: 'fixture',
  kind: 'console',
  timestamp: mtimeMs,
  mtimeMs,
  bytes,
});

// =====================================================================
// Pure helpers
// =====================================================================

describe('pruneByAge', () => {
  it('returns empty when all files are younger than longevityMs', () => {
    const now = 10_000;
    const files = [meta('/a', 9_500, 1), meta('/b', 9_999, 1)];
    expect(pruneByAge(now, 1_000, files)).toEqual([]);
  });
  it('returns only files older than the cutoff', () => {
    const now = 10_000;
    const files = [
      meta('/young', 9_500, 1),
      meta('/old', 8_000, 1),
      meta('/older', 5_000, 1),
    ];
    expect(pruneByAge(now, 1_000, files).map((f) => f.path)).toEqual([
      '/old',
      '/older',
    ]);
  });
  it('longevityMs <= 0 selects everything with any positive age', () => {
    const now = 10_000;
    const files = [meta('/a', 9_999, 1), meta('/b', 1, 1)];
    expect(pruneByAge(now, 0, files)).toHaveLength(2);
  });
  it('longevityMs = Infinity selects nothing', () => {
    const now = 10_000;
    const files = [meta('/a', 1, 1)];
    expect(pruneByAge(now, Infinity, files)).toEqual([]);
  });
});

describe('pruneBySize', () => {
  it('returns empty when total bytes are within budget', () => {
    const files = [meta('/a', 1, 50), meta('/b', 2, 30)];
    expect(pruneBySize(100, files)).toEqual([]);
  });
  it('deletes oldest first until total is within budget', () => {
    // Oldest → newest: a(1, 50), b(2, 30), c(3, 40). Total 120.
    // Budget 60 → delete a (running 120→70 > 60), delete b (70→40 ≤ 60).
    const files = [meta('/c', 3, 40), meta('/a', 1, 50), meta('/b', 2, 30)];
    expect(pruneBySize(60, files).map((f) => f.path)).toEqual(['/a', '/b']);
  });

  it('stops as soon as running total fits — does not over-delete', () => {
    // Oldest → newest: a(1, 50), b(2, 30), c(3, 40). Total 120, budget 70.
    // After deleting a (50), running = 70 ≤ 70 → stop.
    const files = [meta('/a', 1, 50), meta('/b', 2, 30), meta('/c', 3, 40)];
    expect(pruneBySize(70, files).map((f) => f.path)).toEqual(['/a']);
  });
  it('maxBytes = 0 deletes everything', () => {
    const files = [meta('/a', 1, 10), meta('/b', 2, 1)];
    expect(pruneBySize(0, files)).toHaveLength(2);
  });
  it('clamps negative maxBytes to zero (still deletes all)', () => {
    const files = [meta('/a', 1, 10)];
    expect(pruneBySize(-50, files)).toHaveLength(1);
  });
});

// =====================================================================
// scanArchiveFiles — fs walker
// =====================================================================

describe('scanArchiveFiles', () => {
  it('returns [] on a missing baseDir', async () => {
    expect(await scanArchiveFiles(join(dir, 'never'))).toEqual([]);
  });

  it('enumerates every (session, kind) archive file with stat metadata', async () => {
    const base = resolveBuffersBaseDir();
    await appendLine(`${base}/sessA/console/100.jsonl`, '{"sequenceNumber":1}');
    await appendLine(`${base}/sessA/network/200.jsonl`, '{"sequenceNumber":2}');
    await appendLine(`${base}/sessB/console/300.jsonl`, '{"sequenceNumber":3}');
    // Non-jsonl + unknown-kind dirs must be ignored.
    await appendLine(`${base}/sessA/console/readme.txt`, 'noise');
    await appendLine(`${base}/sessA/console/abc.jsonl`, 'non-numeric stem');
    await appendLine(`${base}/sessA/junk/9.jsonl`, 'unknown kind');

    const files = await scanArchiveFiles(base);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      `${base}/sessA/console/100.jsonl`,
      `${base}/sessA/network/200.jsonl`,
      `${base}/sessB/console/300.jsonl`,
    ]);
    for (const f of files) {
      const st = await stat(f.path);
      expect(f.bytes).toBe(st.size);
      expect(f.mtimeMs).toBe(st.mtimeMs);
    }
  });
});

// =====================================================================
// pruneArchives — end-to-end
// =====================================================================

const setMtime = async (path: string, mtimeSec: number): Promise<void> => {
  await utimes(path, mtimeSec, mtimeSec);
};

describe('pruneArchives — end-to-end', () => {
  it('returns zeroed stats when buffers/ does not exist', async () => {
    const res = await pruneArchives({
      getSetting: makeGetSetting(),
    });
    expect(res).toEqual({
      deletedByAge: 0,
      deletedBySize: 0,
      bytesAfter: 0,
      filesAfter: 0,
    });
  });

  it('reaps files past archiveLongevityDays', async () => {
    const base = resolveBuffersBaseDir();
    const old1 = `${base}/s1/console/1.jsonl`;
    const old2 = `${base}/s1/network/2.jsonl`;
    const fresh = `${base}/s1/console/3.jsonl`;
    for (const p of [old1, old2, fresh]) {
      await appendLine(p, '{"sequenceNumber":1}');
    }
    // Stamp the two old files 10 days in the past; fresh stays at "now".
    const nowSec = 1_700_000_000;
    await setMtime(old1, nowSec - 10 * 86_400);
    await setMtime(old2, nowSec - 10 * 86_400);
    await setMtime(fresh, nowSec);

    const res = await pruneArchives({
      getSetting: makeGetSetting({
        'capture.diskSpill.archiveLongevityDays': 7,
        'capture.diskSpill.maxBytes': 1_000_000_000,
      }),
      now: () => nowSec * 1000,
    });
    expect(res.deletedByAge).toBe(2);
    expect(res.deletedBySize).toBe(0);
    expect(res.filesAfter).toBe(1);
    // Survivors:
    await expect(stat(fresh)).resolves.toBeDefined();
    await expect(stat(old1)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(old2)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces maxBytes by removing the oldest survivors after the age pass', async () => {
    const base = resolveBuffersBaseDir();
    // Three files, all under the age cutoff. Bytes ≈ same; budget keeps 1.
    const paths = [
      `${base}/s/console/1.jsonl`,
      `${base}/s/console/2.jsonl`,
      `${base}/s/console/3.jsonl`,
    ];
    for (const p of paths) {
      await appendLine(p, '{"sequenceNumber":1}');
      await appendLine(p, '{"sequenceNumber":2}');
    }
    const nowSec = 1_700_000_000;
    await setMtime(paths[0]!, nowSec - 30);
    await setMtime(paths[1]!, nowSec - 20);
    await setMtime(paths[2]!, nowSec - 10);

    const sizes = await Promise.all(paths.map((p) => stat(p)));
    const totalBytes = sizes.reduce((s, st) => s + st.size, 0);
    // Budget that keeps only the newest file.
    const budget = sizes[2]!.size;

    const res = await pruneArchives({
      getSetting: makeGetSetting({
        'capture.diskSpill.archiveLongevityDays': 365,
        'capture.diskSpill.maxBytes': budget,
      }),
      now: () => nowSec * 1000,
    });

    expect(res.deletedByAge).toBe(0);
    expect(res.deletedBySize).toBe(2);
    expect(res.filesAfter).toBe(1);
    expect(res.bytesAfter).toBeLessThanOrEqual(budget);
    expect(res.bytesAfter).toBe(sizes[2]!.size);
    // The oldest two are gone, newest remains.
    await expect(stat(paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths[2]!)).resolves.toBeDefined();
    expect(totalBytes).toBeGreaterThan(budget); // sanity
  });

  it('combines age + size cuts in a single pass', async () => {
    const base = resolveBuffersBaseDir();
    const stale = `${base}/s/console/1.jsonl`;
    const big1 = `${base}/s/console/2.jsonl`;
    const big2 = `${base}/s/console/3.jsonl`;
    await appendLine(stale, '{"sequenceNumber":1}');
    for (const p of [big1, big2]) {
      for (let i = 0; i < 5; i++) {
        await appendLine(p, `{"sequenceNumber":${i + 2}}`);
      }
    }
    const nowSec = 1_700_000_000;
    await setMtime(stale, nowSec - 10 * 86_400); // age cut
    await setMtime(big1, nowSec - 60); // older survivor
    await setMtime(big2, nowSec - 30); // newer survivor

    const big1Size = (await stat(big1)).size;
    const big2Size = (await stat(big2)).size;
    const budget = big2Size; // forces big1 to be size-pruned after stale falls

    const res = await pruneArchives({
      getSetting: makeGetSetting({
        'capture.diskSpill.archiveLongevityDays': 7,
        'capture.diskSpill.maxBytes': budget,
      }),
      now: () => nowSec * 1000,
    });

    expect(res.deletedByAge).toBe(1);
    expect(res.deletedBySize).toBe(1);
    expect(res.filesAfter).toBe(1);
    expect(res.bytesAfter).toBe(big2Size);
    void big1Size;
  });
});

// =====================================================================
// bridgeWriterToOnEvict
// =====================================================================

describe('bridgeWriterToOnEvict', () => {
  it('forwards (kind, entry) to writer.write fire-and-forget', async () => {
    const calls: Array<{ kind: string; entry: unknown }> = [];
    const fakeWriter = {
      write: async (kind: string, entry: unknown) => {
        calls.push({ kind, entry });
      },
      getStats: () => ({ writeCount: 0, dropCount: 0 }),
    };
    const bridge = bridgeWriterToOnEvict(fakeWriter as never);
    bridge('console', { sequenceNumber: 1, ts: 1 } as never);
    bridge('network', { sequenceNumber: 2, ts: 2 } as never);
    // Drain microtasks so the fire-and-forget writes have run.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([
      { kind: 'console', entry: { sequenceNumber: 1, ts: 1 } },
      { kind: 'network', entry: { sequenceNumber: 2, ts: 2 } },
    ]);
  });

  it('respects writer gating — disabled spill drops via the writer counter', async () => {
    const getSetting = makeGetSetting({
      'capture.diskSpill.enabled': false,
      'capture.diskSpill.maxBytes': 1_000_000,
    });
    const w = createArchiveWriter({
      sessionId: 's',
      getSetting,
      now: () => 100,
    });
    const bridge = bridgeWriterToOnEvict(w);
    bridge('console', { sequenceNumber: 1, ts: 1 } as never);
    // Drop is recorded synchronously in writer.write before the first await.
    await Promise.resolve();
    await Promise.resolve();
    expect(w.getStats()).toEqual({ writeCount: 0, dropCount: 1 });
    await expect(
      stat(resolveArchivePath('s', 'console', 100)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('swallows fs errors so eviction never crashes the SW pipeline', async () => {
    const fakeWriter = {
      write: async () => {
        throw new Error('disk full');
      },
      getStats: () => ({ writeCount: 0, dropCount: 0 }),
    };
    const bridge = bridgeWriterToOnEvict(fakeWriter as never);
    expect(() => bridge('console', { sequenceNumber: 1, ts: 1 } as never)).not.toThrow();
    // Awaiting microtasks must not surface an unhandled rejection.
    await Promise.resolve();
    await Promise.resolve();
  });
});

// =====================================================================
// createArchiveWriter onRotate hook (T3)
// =====================================================================

describe('createArchiveWriter — onRotate hook', () => {
  it('fires onRotate on first write (file open) and on subsequent rotations', async () => {
    const calls: number[] = [];
    let tick = 0;
    const getSetting = makeGetSetting({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 80, // → cap = 20, forces rotation
    });
    const w = createArchiveWriter({
      sessionId: 's',
      getSetting,
      now: () => ++tick * 100,
      onRotate: () => calls.push(tick),
    });
    await w.write('console', { sequenceNumber: 1, ts: 1 } as never);
    await w.write('console', { sequenceNumber: 2, ts: 2 } as never);
    await w.write('console', { sequenceNumber: 3, ts: 3 } as never);
    // Open (tick=1) + rotate (tick=2) + rotate (tick=3) = 3 calls.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toBe(1);
  });

  it('swallows onRotate exceptions so the write path stays alive', async () => {
    const getSetting = makeGetSetting({
      'capture.diskSpill.enabled': true,
      'capture.diskSpill.maxBytes': 1_000_000,
    });
    const w = createArchiveWriter({
      sessionId: 's',
      getSetting,
      now: () => 100,
      onRotate: () => {
        throw new Error('pruner boom');
      },
    });
    await expect(
      w.write('console', { sequenceNumber: 1, ts: 1 } as never),
    ).resolves.toBeUndefined();
    expect(w.getStats().writeCount).toBe(1);
  });
});

// Unused-symbol guard: keep `writeFile` import warning-free if a future
// case decides to use it directly.
void writeFile;
