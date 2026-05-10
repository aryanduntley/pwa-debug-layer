import { z } from 'zod';
import {
  errorResponse,
  type ToolResponse,
} from '../tool_registry.js';
import type { TailFilterError } from '../../captures_query/captures_query.js';
import type {
  ConsoleLevel,
  Cursor,
  FilterSpec,
} from '@pwa-debug/shared';

export const filterSchema = z
  .object({
    level: z
      .array(z.enum(['log', 'info', 'warn', 'error', 'debug', 'trace']))
      .optional(),
    pattern: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      })
      .optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().optional(),
    selectors: z.array(z.string()).optional(),
  })
  .optional();

export const FILTER_SPEC_HINT =
  'FilterSpec keys (all optional): level=ConsoleLevel[] (log|info|warn|error|debug|trace) — applies to console events only; pattern.include/exclude=regex source strings (compiled with new RegExp at the host); since/until=opaque cursor strings from a prior response; limit=int 1..1000 (default 200); selectors reserved for DOM tail tools.';

export const toFilterSpec = (
  raw: z.infer<typeof filterSchema>,
): FilterSpec | undefined => {
  if (raw === undefined) return undefined;
  const result: {
    level?: readonly ConsoleLevel[];
    pattern?: {
      include?: readonly string[];
      exclude?: readonly string[];
    };
    since?: Cursor;
    until?: Cursor;
    limit?: number;
    selectors?: readonly string[];
  } = {};
  if (raw.level !== undefined) result.level = raw.level;
  if (raw.pattern !== undefined) {
    const p: { include?: readonly string[]; exclude?: readonly string[] } = {};
    if (raw.pattern.include !== undefined) p.include = raw.pattern.include;
    if (raw.pattern.exclude !== undefined) p.exclude = raw.pattern.exclude;
    result.pattern = p;
  }
  if (raw.since !== undefined) result.since = raw.since as Cursor;
  if (raw.until !== undefined) result.until = raw.until as Cursor;
  if (raw.limit !== undefined) result.limit = raw.limit;
  if (raw.selectors !== undefined) result.selectors = raw.selectors;
  return result;
};

export const tailErrorToResponse = (err: TailFilterError): ToolResponse => {
  switch (err.kind) {
    case 'cursor_invalid':
      return errorResponse(
        `filter.${err.fieldPath} is not a valid cursor: ${err.error}`,
        [
          `Cursors are opaque tokens returned in prior tail responses. Drop filter.${err.fieldPath} and call again to get a fresh cursor; then page forward by passing it as filter.since.`,
          FILTER_SPEC_HINT,
        ],
      );
    case 'cursor_session_mismatch':
      return errorResponse(
        `filter.${err.fieldPath} cursor was minted in session ${err.cursorSessionId}, but the current host buffer session is ${err.currentSessionId}. The host registry was reset (extension reload, host restart, or capture clear).`,
        [
          `Drop the stale cursor and call again without filter.${err.fieldPath} to get a fresh tail. Use the returned cursor for forward pagination.`,
          FILTER_SPEC_HINT,
        ],
      );
    case 'pattern_invalid':
      return errorResponse(
        `filter.${err.fieldPath} is not a valid JS regex source: ${err.error}`,
        [
          'Each pattern.include / pattern.exclude entry is compiled via new RegExp(source). Escape regex metacharacters in literal strings (e.g. literal "(" as "\\\\(", literal "." as "\\\\.").',
          FILTER_SPEC_HINT,
        ],
      );
    case 'limit_invalid':
      return errorResponse(`filter.limit invalid: ${err.error}`, [
        'limit must be a finite integer in [1, 1000]. Default is 200 when omitted.',
        FILTER_SPEC_HINT,
      ]);
  }
};
