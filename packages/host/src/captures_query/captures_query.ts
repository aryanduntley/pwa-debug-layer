import type { RingBuffer } from '../host_buffers/host_buffers.js';
import type { HostStoredEvent } from '../captures_in/captures_in.js';
import type {
  ConsoleLevel,
  Cursor,
  CursorParts,
  FilterPattern,
  FilterSpec,
} from '@pwa-debug/shared';
import { decodeCursor, encodeCursor } from '@pwa-debug/shared';

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

export const tailWithFilter = <E extends HostStoredEvent>(
  buffer: RingBuffer<E>,
  spec: FilterSpec | undefined,
  ctx: TailFilterContext,
): TailWithFilterResult<E> => {
  const limitResult = validateLimit(spec?.limit);
  if (!limitResult.ok) return { ok: false, error: limitResult.error };
  const limit = limitResult.value;

  const sinceResult = decodeCursorField(
    spec?.since,
    'since',
    ctx.currentSessionId,
  );
  if (!sinceResult.ok) return { ok: false, error: sinceResult.error };
  const sinceParts = sinceResult.value;

  const untilResult = decodeCursorField(
    spec?.until,
    'until',
    ctx.currentSessionId,
  );
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

  const accepts = (event: E): boolean => {
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

  const matching = buffer.tail({ filter: accepts });

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
