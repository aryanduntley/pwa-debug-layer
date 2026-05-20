import type { RingBuffer } from '../host_buffers/host_buffers.js';
import type { HostStoredEvent } from '../captures_in/captures_in.js';
import type {
  CaptureKind,
  ConsoleLevel,
  Cursor,
  CursorParts,
  FilterPattern,
  FilterSpec,
} from '@pwa-debug/shared';
import { decodeCursor, encodeCursor } from '@pwa-debug/shared';
import {
  readArchive,
  type ArchiveReadInput,
  type ArchiveReadResult,
} from '../host_archive/host_archive.js';

export type TailFilterContext = {
  readonly currentSessionId: string;
};

export type TailFilterError =
  | {
      readonly kind: 'cursor_invalid';
      readonly fieldPath: 'since' | 'until';
      readonly error: string;
    }
  | {
      readonly kind: 'cursor_session_mismatch';
      readonly fieldPath: 'since' | 'until';
      readonly cursorSessionId: string;
      readonly currentSessionId: string;
    }
  | {
      readonly kind: 'pattern_invalid';
      readonly fieldPath: string;
      readonly error: string;
    }
  | {
      readonly kind: 'limit_invalid';
      readonly fieldPath: 'limit';
      readonly error: string;
    };

export type TailWithFilterResult<E extends HostStoredEvent> =
  | {
      readonly ok: true;
      readonly entries: readonly E[];
      readonly cursor: Cursor | null;
      readonly hasMore: boolean;
    }
  | {
      readonly ok: false;
      readonly error: TailFilterError;
    };

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type ResultOk<T> = { readonly ok: true; readonly value: T };
type ResultErr = { readonly ok: false; readonly error: TailFilterError };
type Res<T> = ResultOk<T> | ResultErr;

const validateLimit = (limit: number | undefined): Res<number> => {
  if (limit === undefined) return { ok: true, value: DEFAULT_LIMIT };
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return {
      ok: false,
      error: {
        kind: 'limit_invalid',
        fieldPath: 'limit',
        error: `limit must be a finite number; got ${String(limit)}`,
      },
    };
  }
  if (!Number.isInteger(limit)) {
    return {
      ok: false,
      error: {
        kind: 'limit_invalid',
        fieldPath: 'limit',
        error: `limit must be an integer; got ${limit}`,
      },
    };
  }
  if (limit < 1) {
    return {
      ok: false,
      error: {
        kind: 'limit_invalid',
        fieldPath: 'limit',
        error: `limit must be >= 1; got ${limit}`,
      },
    };
  }
  if (limit > MAX_LIMIT) {
    return {
      ok: false,
      error: {
        kind: 'limit_invalid',
        fieldPath: 'limit',
        error: `limit must be <= ${MAX_LIMIT}; got ${limit}`,
      },
    };
  }
  return { ok: true, value: limit };
};

const decodeCursorField = (
  cursor: Cursor | undefined,
  fieldPath: 'since' | 'until',
  currentSessionId: string,
): Res<CursorParts | null> => {
  if (cursor === undefined) return { ok: true, value: null };
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) {
    return {
      ok: false,
      error: { kind: 'cursor_invalid', fieldPath, error: decoded.error },
    };
  }
  if (decoded.value.sessionId !== currentSessionId) {
    return {
      ok: false,
      error: {
        kind: 'cursor_session_mismatch',
        fieldPath,
        cursorSessionId: decoded.value.sessionId,
        currentSessionId,
      },
    };
  }
  return { ok: true, value: decoded.value };
};

/**
 * Decode a cursor field WITHOUT enforcing sessionId match. The caller (T4
 * tailWithFilterMerged) uses session mismatch as a routing signal to disk,
 * not an error.
 */
const decodeCursorFieldLoose = (
  cursor: Cursor | undefined,
  fieldPath: 'since' | 'until',
): Res<CursorParts | null> => {
  if (cursor === undefined) return { ok: true, value: null };
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) {
    return {
      ok: false,
      error: { kind: 'cursor_invalid', fieldPath, error: decoded.error },
    };
  }
  return { ok: true, value: decoded.value };
};

const compilePatternList = (
  sources: readonly string[] | undefined,
  fieldPathPrefix: string,
): Res<readonly RegExp[]> => {
  if (sources === undefined || sources.length === 0) {
    return { ok: true, value: [] };
  }
  const compiled: RegExp[] = [];
  let i = 0;
  for (const src of sources) {
    try {
      compiled.push(new RegExp(src));
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'pattern_invalid',
          fieldPath: `${fieldPathPrefix}[${i}]`,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
    i++;
  }
  return { ok: true, value: compiled };
};

const compilePatterns = (
  pattern: FilterPattern | undefined,
): Res<{
  readonly include: readonly RegExp[];
  readonly exclude: readonly RegExp[];
}> => {
  if (pattern === undefined) {
    return { ok: true, value: { include: [], exclude: [] } };
  }
  const inc = compilePatternList(pattern.include, 'pattern.include');
  if (!inc.ok) return inc;
  const exc = compilePatternList(pattern.exclude, 'pattern.exclude');
  if (!exc.ok) return exc;
  return { ok: true, value: { include: inc.value, exclude: exc.value } };
};

const eventTextForPattern = (event: HostStoredEvent): string => {
  try {
    return JSON.stringify(event) ?? '';
  } catch {
    return '';
  }
};

/**
 * Pre-compiled FilterSpec ready for application against any source of
 * HostStoredEvent (memory ring buffer + host_archive disk). Produced by
 * compileTailFilter so both tailWithFilter and tailWithFilterMerged share
 * one predicate + parsed pagination state — no duplication, no drift.
 */
export type CompiledTailFilter = {
  readonly predicate: (event: HostStoredEvent) => boolean;
  readonly sinceParts: CursorParts | null;
  readonly untilParts: CursorParts | null;
  readonly limit: number;
};

/**
 * Compile a FilterSpec into a reusable predicate + parsed pagination state.
 * Validates limit, decodes since/until WITHOUT sessionId-match enforcement
 * (the caller routes on mismatch), compiles patterns, builds the level set.
 * Pure (no fs, no buffer access).
 */
export const compileTailFilter = (
  spec: FilterSpec | undefined,
  ctx: TailFilterContext,
): Res<CompiledTailFilter> => {
  const limitResult = validateLimit(spec?.limit);
  if (!limitResult.ok) return { ok: false, error: limitResult.error };
  const limit = limitResult.value;

  const sinceResult = decodeCursorFieldLoose(spec?.since, 'since');
  if (!sinceResult.ok) return { ok: false, error: sinceResult.error };
  const sinceParts = sinceResult.value;

  const untilResult = decodeCursorFieldLoose(spec?.until, 'until');
  if (!untilResult.ok) return { ok: false, error: untilResult.error };
  const untilParts = untilResult.value;

  const patternsResult = compilePatterns(spec?.pattern);
  if (!patternsResult.ok) return { ok: false, error: patternsResult.error };
  const includePatterns = patternsResult.value.include;
  const excludePatterns = patternsResult.value.exclude;

  const levelSet =
    spec?.level !== undefined && spec.level.length > 0
      ? new Set<ConsoleLevel>(spec.level)
      : null;

  const predicate = (event: HostStoredEvent): boolean => {
    if (
      sinceParts !== null &&
      !(event.sequenceNumber > sinceParts.sequenceNumber)
    ) {
      return false;
    }
    if (
      untilParts !== null &&
      !(event.sequenceNumber < untilParts.sequenceNumber)
    ) {
      return false;
    }
    if (levelSet !== null) {
      const lvl = (event as unknown as { level?: ConsoleLevel }).level;
      if (lvl === undefined || !levelSet.has(lvl)) return false;
    }
    if (includePatterns.length > 0 || excludePatterns.length > 0) {
      const text = eventTextForPattern(event);
      for (const re of excludePatterns) {
        if (re.test(text)) return false;
      }
      if (includePatterns.length > 0) {
        let anyInclude = false;
        for (const re of includePatterns) {
          if (re.test(text)) {
            anyInclude = true;
            break;
          }
        }
        if (!anyInclude) return false;
      }
    }
    return true;
  };

  void ctx; // reserved for future ctx-aware compilation
  return {
    ok: true,
    value: { predicate, sinceParts, untilParts, limit },
  };
};

const sessionMismatch = (
  fieldPath: 'since' | 'until',
  cursorSessionId: string,
  currentSessionId: string,
): TailFilterError => ({
  kind: 'cursor_session_mismatch',
  fieldPath,
  cursorSessionId,
  currentSessionId,
});

export const tailWithFilter = <E extends HostStoredEvent>(
  buffer: RingBuffer<E>,
  spec: FilterSpec | undefined,
  ctx: TailFilterContext,
): TailWithFilterResult<E> => {
  const compiled = compileTailFilter(spec, ctx);
  if (!compiled.ok) return { ok: false, error: compiled.error };
  const { predicate, sinceParts, untilParts, limit } = compiled.value;

  // Memory-only callers enforce sessionId match (preserves prior contract).
  if (sinceParts !== null && sinceParts.sessionId !== ctx.currentSessionId) {
    return {
      ok: false,
      error: sessionMismatch(
        'since',
        sinceParts.sessionId,
        ctx.currentSessionId,
      ),
    };
  }
  if (untilParts !== null && untilParts.sessionId !== ctx.currentSessionId) {
    return {
      ok: false,
      error: sessionMismatch(
        'until',
        untilParts.sessionId,
        ctx.currentSessionId,
      ),
    };
  }

  const matching = buffer.tail({ filter: predicate as (e: E) => boolean });

  let entries: readonly E[];
  let hasMore: boolean;
  if (sinceParts !== null) {
    if (matching.length > limit) {
      entries = matching.slice(0, limit);
      hasMore = true;
    } else {
      entries = matching;
      hasMore = false;
    }
  } else {
    entries =
      matching.length > limit
        ? matching.slice(matching.length - limit)
        : matching;
    hasMore = false;
  }

  if (entries.length === 0) {
    return { ok: true, entries, cursor: null, hasMore };
  }
  const lastEntry = entries[entries.length - 1];
  if (lastEntry === undefined) {
    return { ok: true, entries, cursor: null, hasMore };
  }
  const cursor = encodeCursor({
    sessionId: ctx.currentSessionId,
    sequenceNumber: lastEntry.sequenceNumber,
  });
  return { ok: true, entries, cursor, hasMore };
};

// =====================================================================
// T4 — memory→disk merge orchestrator
// =====================================================================

/**
 * Input to tailWithFilterMerged. Adds kind + injectable readDisk on top of
 * tailWithFilter's (buffer, spec, ctx) so a sinceCursor predating the
 * in-memory tail routes into host_archive.readArchive and merges into the
 * same TailWithFilterResult shape.
 */
export type TailMergedInput<E extends HostStoredEvent> = {
  readonly buffer: RingBuffer<E>;
  readonly spec: FilterSpec | undefined;
  readonly ctx: TailFilterContext;
  readonly kind: CaptureKind;
  readonly readDisk?: (input: ArchiveReadInput) => Promise<ArchiveReadResult>;
};

/**
 * Memory→disk-merging tail orchestrator. Routes spec.since by sessionId:
 *   no since                              → memory-only "latest" (no disk)
 *   since.sessionId === currentSessionId  → current-session merge: disk
 *                                           (for the gap predating memory)
 *                                           + memory, concatenated
 *   since.sessionId !== currentSessionId  → prior-session pure-disk read;
 *                                           cursor encodes against the
 *                                           prior sessionId
 * Until-cursor with a different sessionId than the routing session →
 * cursor_session_mismatch (malformed pagination, not routing).
 */
export const tailWithFilterMerged = async <E extends HostStoredEvent>(
  input: TailMergedInput<E>,
): Promise<TailWithFilterResult<E>> => {
  const { buffer, spec, ctx, kind } = input;
  const readDisk = input.readDisk ?? readArchive;

  // No since → memory-only "latest" semantics.
  if (spec?.since === undefined) {
    return tailWithFilter(buffer, spec, ctx);
  }

  const compiled = compileTailFilter(spec, ctx);
  if (!compiled.ok) return { ok: false, error: compiled.error };
  const { predicate, sinceParts, untilParts, limit } = compiled.value;
  if (sinceParts === null) {
    // Defensive: spec.since was set but decode produced null — shouldn't
    // happen with the loose decoder, but fall back to memory.
    return tailWithFilter(buffer, spec, ctx);
  }

  const routingSessionId = sinceParts.sessionId;

  if (untilParts !== null && untilParts.sessionId !== routingSessionId) {
    return {
      ok: false,
      error: sessionMismatch(
        'until',
        untilParts.sessionId,
        routingSessionId,
      ),
    };
  }

  const diskInput: ArchiveReadInput = {
    sessionId: routingSessionId,
    kind,
    sinceSeq: sinceParts.sequenceNumber,
    ...(untilParts !== null && { untilSeq: untilParts.sequenceNumber }),
    // Generous raw cap so the predicate has headroom; we trim to spec.limit.
    limit: MAX_LIMIT,
  };

  const diskRead = await readDisk(diskInput);
  const diskFiltered: HostStoredEvent[] = [];
  let diskOverflow = false;
  for (const entry of diskRead.entries) {
    if (!predicate(entry)) continue;
    if (diskFiltered.length >= limit) {
      diskOverflow = true;
      break;
    }
    diskFiltered.push(entry);
  }

  const encodeCursorOrNull = (
    sessionId: string,
    seq: number | undefined,
  ): Cursor | null =>
    seq === undefined ? null : encodeCursor({ sessionId, sequenceNumber: seq });

  // Prior-session routing — disk only.
  if (routingSessionId !== ctx.currentSessionId) {
    const entries = diskFiltered as unknown as readonly E[];
    const last = entries[entries.length - 1]?.sequenceNumber;
    return {
      ok: true,
      entries,
      cursor: encodeCursorOrNull(routingSessionId, last),
      hasMore: diskOverflow || diskRead.hasMore,
    };
  }

  // Current-session merge — disk first, then memory for the remainder.
  if (diskOverflow || diskFiltered.length === limit) {
    const entries = diskFiltered as unknown as readonly E[];
    const last = entries[entries.length - 1]?.sequenceNumber;
    return {
      ok: true,
      entries,
      cursor: encodeCursorOrNull(ctx.currentSessionId, last),
      hasMore: diskOverflow || diskRead.hasMore,
    };
  }

  const remaining = limit - diskFiltered.length;
  const memorySpec: FilterSpec = { ...spec, limit: remaining };
  const memoryResult = tailWithFilter(buffer, memorySpec, ctx);
  if (!memoryResult.ok) return memoryResult;

  const entries = [
    ...(diskFiltered as unknown as E[]),
    ...memoryResult.entries,
  ] as readonly E[];
  const last = entries[entries.length - 1]?.sequenceNumber;
  return {
    ok: true,
    entries,
    cursor: encodeCursorOrNull(ctx.currentSessionId, last),
    hasMore: diskRead.hasMore || memoryResult.hasMore,
  };
};
