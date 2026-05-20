/**
 * Host-side rolling jsonl archive for the captures ring buffer (M8 — disk
 * spill). The writer turns evicted ring-buffer entries into per-(session,
 * kind) rotated jsonl files under ~/.config/pwa-debug/buffers/. Reader (T2)
 * and pruner (T3) compose the same path/threshold primitives so the on-disk
 * layout has one source of truth.
 *
 * Plug-ability: the writer reads `capture.diskSpill.enabled` and
 * `capture.diskSpill.maxBytes` LIVE via the injected getSetting on every
 * write — no internal cache — so a live setting flip takes effect on the
 * very next write without restart. Adding a new disk-spill knob is one
 * entry in settings_schema; the writer needs zero shape changes.
 *
 * Side effects (fs) flow exclusively through host_io.appendLine. The
 * factory itself touches no fs primitives directly so the FP boundary
 * stays at the host_io edge.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import type {
  CaptureKind,
  SettingKey,
  SettingTypeMap,
} from '@pwa-debug/shared';
import type { HostStoredEvent } from '../captures_in/captures_in.js';
import {
  appendLine,
  readLines,
  xdgConfigPath,
} from '../host_io/host_io.js';

/** Counter snapshot returned by ArchiveWriter.getStats. Frozen on read. */
export type ArchiveWriteStats = {
  readonly writeCount: number;
  readonly dropCount: number;
};

/**
 * Input to readArchive. Scopes the read to one (sessionId, kind), with
 * optional cursor-style sequenceNumber bounds + limit. Cursor decode lives
 * in the caller (T4 will use @pwa-debug/shared decodeCursor); T2's reader
 * takes raw seq numbers so it stays filter-naive and composable.
 */
export type ArchiveReadInput = {
  readonly sessionId: string;
  readonly kind: CaptureKind;
  /** Exclusive lower bound on sequenceNumber: yield only entries with seq > sinceSeq. */
  readonly sinceSeq?: number;
  /** Exclusive upper bound on sequenceNumber: stop once seq >= untilSeq. */
  readonly untilSeq?: number;
  /** Max entries to return (default 200, capped at 1000 — mirrors captures_query). */
  readonly limit?: number;
};

/**
 * Output of readArchive. Mirrors captures_query.TailWithFilterResult so the
 * T4 memory→disk merger can stitch slices without shape transforms.
 */
export type ArchiveReadResult = {
  readonly entries: readonly HostStoredEvent[];
  readonly hasMore: boolean;
};

/**
 * Input to createArchiveWriter. sessionId scopes archive paths; getSetting
 * is the live dependency on host_settings (capture.diskSpill.enabled,
 * capture.diskSpill.maxBytes); now is an injectable clock for tests;
 * onRotate (T3) is called sync immediately after a fresh rotation path is
 * derived, before the new file is touched — mcp_mode wires this to a
 * fire-and-forget pruneArchives pass.
 */
export type ArchiveWriterInput = {
  readonly sessionId: string;
  readonly getSetting: <K extends SettingKey>(key: K) => SettingTypeMap[K];
  readonly now?: () => number;
  readonly onRotate?: () => void;
};

/**
 * Closure-bag returned by createArchiveWriter. Object-frozen so consumers
 * cannot monkey-patch. write performs the gated, rotating jsonl append;
 * getStats yields the current frozen counter snapshot.
 */
export type ArchiveWriter = {
  readonly write: (kind: CaptureKind, entry: unknown) => Promise<void>;
  readonly getStats: () => ArchiveWriteStats;
};

// =====================================================================
// Pure helpers (tracked, exported for reader/pruner reuse in T2/T3)
// =====================================================================

/**
 * Per-kind archive directory under the session root. Single source of
 * truth for the layout — the reader's listArchiveFiles enumerates this
 * directory, and resolveArchivePath composes it with the timestamp.jsonl
 * tail. DRY: the path math lives here, callers never construct strings.
 */
export const resolveArchiveDir = (
  sessionId: string,
  kind: CaptureKind,
): string => xdgConfigPath(`buffers/${sessionId}/${kind}`);

/**
 * Absolute path to one rotated archive file. Composes resolveArchiveDir +
 * <rotationTimestamp>.jsonl so reader + writer share identical path math.
 */
export const resolveArchivePath = (
  sessionId: string,
  kind: CaptureKind,
  rotationTimestamp: number,
): string => `${resolveArchiveDir(sessionId, kind)}/${rotationTimestamp}.jsonl`;

/**
 * Predicate: true when appending nextLineBytes to a file already holding
 * currentBytes would exceed maxBytesPerFile. Centralizes the rotation
 * threshold so the factory and any future re-rotation logic share the
 * same comparison — and so the math is unit-testable without disk.
 */
export const shouldRotate = (
  currentBytes: number,
  nextLineBytes: number,
  maxBytesPerFile: number,
): boolean => currentBytes + nextLineBytes > maxBytesPerFile;

// =====================================================================
// Reader (T2) — pure helpers + streaming orchestrator
// =====================================================================

const ARCHIVE_FILE_RE = /^(\d+)\.jsonl$/;

/**
 * Tagged JSON.parse for one jsonl line. Verifies the minimum shape needed
 * for cursor-bounded iteration (numeric sequenceNumber present). Returns
 * a tagged Result so the reader can skip malformed lines (truncated
 * final line after a host crash mid-write) without halting — robust
 * replay primitive, not a schema validator. T4 layers FilterSpec
 * validation on top.
 */
export const parseArchiveLine = (
  line: string,
):
  | { readonly ok: true; readonly value: HostStoredEvent }
  | { readonly ok: false } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false };
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return { ok: false };
  }
  const seq = (parsed as { sequenceNumber?: unknown }).sequenceNumber;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    return { ok: false };
  }
  return { ok: true, value: parsed as HostStoredEvent };
};

/**
 * Enumerate rotated archive files for one (sessionId, kind) in
 * chronological order (filename = rotationTimestamp, numerically
 * ascending). ENOENT on the directory returns [] silently — a fresh
 * install or capture.diskSpill.enabled=false is a valid steady state,
 * not an error. Non-jsonl entries and non-numeric stems are filtered.
 */
export const listArchiveFiles = async (
  sessionId: string,
  kind: CaptureKind,
): Promise<readonly string[]> => {
  const dir = resolveArchiveDir(sessionId, kind);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const tsByName: Array<readonly [number, string]> = [];
  for (const name of entries) {
    const m = ARCHIVE_FILE_RE.exec(name);
    if (!m) continue;
    const ts = Number(m[1]);
    if (!Number.isFinite(ts)) continue;
    tsByName.push([ts, name]);
  }
  tsByName.sort((a, b) => a[0] - b[0]);
  return tsByName.map(([, name]) => `${dir}/${name}`);
};

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 1000;

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_READ_LIMIT;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    return DEFAULT_READ_LIMIT;
  }
  return Math.min(limit, MAX_READ_LIMIT);
};

/**
 * Cursor-bounded streaming read of one (sessionId, kind)'s on-disk
 * archive. Lists rotated files, then for each in chronological order
 * streams lines via host_io.readLines, decodes each with
 * parseArchiveLine (skipping malformed lines), applies sinceSeq
 * (exclusive lower) + untilSeq (exclusive upper) bounds, and
 * accumulates entries up to limit. Since sequenceNumber is monotonic
 * within a session, once we see seq >= untilSeq we can stop globally.
 *
 * Filter-naive: T2 owns the disk-streaming substrate; T4 layers
 * FilterSpec compilation on top during the memory→disk merge.
 */
export const readArchive = async (
  input: ArchiveReadInput,
): Promise<ArchiveReadResult> => {
  const { sessionId, kind, sinceSeq, untilSeq } = input;
  const limit = clampLimit(input.limit);
  const files = await listArchiveFiles(sessionId, kind);
  const entries: HostStoredEvent[] = [];
  let hasMore = false;
  outer: for (const file of files) {
    for await (const line of readLines(file)) {
      const decoded = parseArchiveLine(line);
      if (!decoded.ok) continue;
      const seq = decoded.value.sequenceNumber;
      if (sinceSeq !== undefined && seq <= sinceSeq) continue;
      if (untilSeq !== undefined && seq >= untilSeq) break outer;
      if (entries.length >= limit) {
        hasMore = true;
        break outer;
      }
      entries.push(decoded.value);
    }
  }
  return { entries, hasMore };
};

// =====================================================================
// Factory
// =====================================================================

const MIN_BYTES_PER_FILE = 1;

/**
 * Per-file size cap derived from the user-facing disk budget:
 * floor(maxBytes / 4) bounds any single archive file to a quarter of the
 * total budget so a long-running kind cannot starve the others. Clamped
 * to MIN_BYTES_PER_FILE so degenerate settings still produce a writable
 * (and rapidly-rotating) state instead of throwing.
 */
const perFileCap = (maxBytes: number): number =>
  Math.max(MIN_BYTES_PER_FILE, Math.floor(maxBytes / 4));

export const createArchiveWriter = (
  input: ArchiveWriterInput,
): ArchiveWriter => {
  const { sessionId, getSetting, now = Date.now, onRotate } = input;
  const currentPathByKind = new Map<CaptureKind, string>();
  const currentBytesByKind = new Map<CaptureKind, number>();
  let writeCount = 0;
  let dropCount = 0;

  const write = async (kind: CaptureKind, entry: unknown): Promise<void> => {
    if (!getSetting('capture.diskSpill.enabled')) {
      dropCount += 1;
      return;
    }
    const line = JSON.stringify(entry);
    // +1 for the trailing '\n' host_io.appendLine writes.
    const nextLineBytes = Buffer.byteLength(line, 'utf-8') + 1;
    const cap = perFileCap(getSetting('capture.diskSpill.maxBytes'));
    const currentBytes = currentBytesByKind.get(kind) ?? 0;
    const hasOpenFile = currentPathByKind.has(kind);
    const rotate =
      !hasOpenFile || shouldRotate(currentBytes, nextLineBytes, cap);
    if (rotate) {
      const path = resolveArchivePath(sessionId, kind, now());
      currentPathByKind.set(kind, path);
      currentBytesByKind.set(kind, 0);
      if (onRotate) {
        try {
          onRotate();
        } catch {
          // onRotate is a hook (typically pruner trigger); never let it
          // crash the eviction-driven write path.
        }
      }
    }
    const targetPath = currentPathByKind.get(kind) as string;
    await appendLine(targetPath, line);
    currentBytesByKind.set(
      kind,
      (currentBytesByKind.get(kind) ?? 0) + nextLineBytes,
    );
    writeCount += 1;
  };

  const getStats = (): ArchiveWriteStats =>
    Object.freeze({ writeCount, dropCount });

  return Object.freeze({ write, getStats });
};

// =====================================================================
// Pruner (T3) — pure-FP-at-edges
// =====================================================================

/**
 * Snapshot of one rotated archive file on disk. Produced by
 * scanArchiveFiles, consumed by pruneByAge (filters by mtime) +
 * pruneBySize (sorts by mtime, sums bytes). Pure data record so the pure
 * pruners operate without further fs calls.
 */
export type ArchiveFileMeta = {
  readonly path: string;
  readonly sessionId: string;
  readonly kind: CaptureKind;
  readonly timestamp: number;
  readonly mtimeMs: number;
  readonly bytes: number;
};

/** Input to pruneArchives. getSetting is the live host_settings dependency. */
export type PruneInput = {
  readonly getSetting: <K extends SettingKey>(key: K) => SettingTypeMap[K];
  readonly now?: () => number;
  readonly baseDir?: string;
};

/** Counter snapshot + post-prune disk totals returned by pruneArchives. */
export type PruneStats = {
  readonly deletedByAge: number;
  readonly deletedBySize: number;
  readonly bytesAfter: number;
  readonly filesAfter: number;
};

const CAPTURE_KIND_SET: ReadonlySet<string> = new Set([
  'console',
  'network',
  'dom_mutations',
  'lifecycle',
]);

const isCaptureKind = (s: string): s is CaptureKind => CAPTURE_KIND_SET.has(s);

const MS_PER_DAY = 86_400_000;

/**
 * Buffers/ root: single source of truth for the cross-session archive
 * directory that scanArchiveFiles enumerates.
 */
export const resolveBuffersBaseDir = (): string => xdgConfigPath('buffers');

/**
 * Pure-at-edges async fs walker. Enumerates every <baseDir>/<sessionId>/
 * <kind>/<timestamp>.jsonl path with its fs.stat metadata. ENOENT on the
 * baseDir or any subdir is treated as "no archive yet" and skipped silently
 * — this matches T1/T2's robustness contract on missing archive trees.
 */
export const scanArchiveFiles = async (
  baseDir: string,
): Promise<readonly ArchiveFileMeta[]> => {
  let sessions: string[];
  try {
    sessions = await readdir(baseDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: ArchiveFileMeta[] = [];
  for (const sessionId of sessions) {
    const sessionDir = `${baseDir}/${sessionId}`;
    let kinds: string[];
    try {
      kinds = await readdir(sessionDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const kindName of kinds) {
      if (!isCaptureKind(kindName)) continue;
      const kindDir = `${sessionDir}/${kindName}`;
      let names: string[];
      try {
        names = await readdir(kindDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const name of names) {
        const m = ARCHIVE_FILE_RE.exec(name);
        if (!m) continue;
        const timestamp = Number(m[1]);
        if (!Number.isFinite(timestamp)) continue;
        const path = `${kindDir}/${name}`;
        let st;
        try {
          st = await stat(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        out.push({
          path,
          sessionId,
          kind: kindName,
          timestamp,
          mtimeMs: st.mtimeMs,
          bytes: st.size,
        });
      }
    }
  }
  return out;
};

/**
 * Pure filter: returns files whose (now - mtimeMs) exceeds longevityMs —
 * the age-victims that pruneArchives will unlink. longevityMs ≤ 0 selects
 * all; longevityMs = Infinity selects none.
 */
export const pruneByAge = (
  now: number,
  longevityMs: number,
  files: readonly ArchiveFileMeta[],
): readonly ArchiveFileMeta[] =>
  files.filter((f) => now - f.mtimeMs > longevityMs);

/**
 * Pure transform: when the sum of file bytes exceeds maxBytes, returns the
 * oldest-first prefix that must be deleted to push total ≤ maxBytes.
 * Total ≤ max → returns []. maxBytes ≤ 0 → returns all files (delete all).
 * Stable sort by mtimeMs ascending.
 */
export const pruneBySize = (
  maxBytes: number,
  files: readonly ArchiveFileMeta[],
): readonly ArchiveFileMeta[] => {
  const cap = Math.max(0, maxBytes);
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total <= cap) return [];
  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const victims: ArchiveFileMeta[] = [];
  let running = total;
  for (const f of sorted) {
    if (running <= cap) break;
    victims.push(f);
    running -= f.bytes;
  }
  return victims;
};

const safeUnlink = async (path: string): Promise<boolean> => {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
};

/**
 * Pruner orchestrator. Reads capture.diskSpill.archiveLongevityDays +
 * capture.diskSpill.maxBytes live via getSetting, scanArchiveFiles, runs
 * pruneByAge → unlink, then pruneBySize over the survivors → unlink.
 * Returns PruneStats describing what was removed plus the post-prune
 * disk total. Missing buffers/ → zeroed stats (no-op). Triggered by
 * mcp_mode on host boot and on every writer rotation event.
 */
export const pruneArchives = async (
  input: PruneInput,
): Promise<PruneStats> => {
  const baseDir = input.baseDir ?? resolveBuffersBaseDir();
  const now = (input.now ?? Date.now)();
  const longevityDays = input.getSetting(
    'capture.diskSpill.archiveLongevityDays',
  );
  const maxBytes = input.getSetting('capture.diskSpill.maxBytes');
  const longevityMs = longevityDays * MS_PER_DAY;
  const initial = await scanArchiveFiles(baseDir);
  if (initial.length === 0) {
    return { deletedByAge: 0, deletedBySize: 0, bytesAfter: 0, filesAfter: 0 };
  }
  const ageVictims = pruneByAge(now, longevityMs, initial);
  let deletedByAge = 0;
  for (const f of ageVictims) {
    if (await safeUnlink(f.path)) deletedByAge += 1;
  }
  const ageVictimPaths = new Set(ageVictims.map((f) => f.path));
  const survivors = initial.filter((f) => !ageVictimPaths.has(f.path));
  const sizeVictims = pruneBySize(maxBytes, survivors);
  let deletedBySize = 0;
  for (const f of sizeVictims) {
    if (await safeUnlink(f.path)) deletedBySize += 1;
  }
  const sizeVictimPaths = new Set(sizeVictims.map((f) => f.path));
  const finalSurvivors = survivors.filter(
    (f) => !sizeVictimPaths.has(f.path),
  );
  const bytesAfter = finalSurvivors.reduce((sum, f) => sum + f.bytes, 0);
  return {
    deletedByAge,
    deletedBySize,
    bytesAfter,
    filesAfter: finalSurvivors.length,
  };
};

// =====================================================================
// onEvict bridge (T3)
// =====================================================================

/**
 * Closes over an ArchiveWriter and returns the kind-aware onEvict callback
 * captures_in's ring buffers fire on FIFO eviction. Calls writer.write
 * fire-and-forget — the writer's drop counter already accounts for
 * capture.diskSpill.enabled=false, and any fs error during eviction must
 * NOT crash the SW pipeline. Decouples captures_in (per-kind ring buffers)
 * from host_archive (rotated jsonl persistence).
 */
export const bridgeWriterToOnEvict = (
  writer: ArchiveWriter,
): ((kind: CaptureKind, evicted: HostStoredEvent) => void) =>
  (kind, evicted) => {
    void writer.write(kind, evicted).catch(() => undefined);
  };
