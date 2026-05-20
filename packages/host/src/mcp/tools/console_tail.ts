import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { resolveTarget } from './target_resolution.js';
import { tailWithFilterMerged } from '../../captures_query/captures_query.js';
import {
  encodeCursor,
  type ConsoleEntry,
} from '@pwa-debug/shared';
import {
  FILTER_SPEC_HINT,
  filterSchema,
  tailErrorToResponse,
  toFilterSpec,
} from './_filter_helpers.js';

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  filter: filterSchema,
};

export const consoleTailHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions.',
      FILTER_SPEC_HINT,
    ]);
  }

  const captures = ctx.capturesRegistry.get(target.extensionId);
  if (captures === undefined) {
    return okResponse(
      { entries: [], cursor: null, hasMore: false },
      [
        `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. The CapturesIn instance is created lazily on first event — trigger console activity in a tab and retry.`,
        FILTER_SPEC_HINT,
      ],
    );
  }

  const sessionId = captures.getStats().sessionId;
  const consoleBuffer = captures.buffer('console');
  const filterSpec = toFilterSpec(args.filter);
  const result = await tailWithFilterMerged({
    buffer: consoleBuffer,
    spec: filterSpec,
    ctx: { currentSessionId: sessionId },
    kind: 'console',
  });

  if (!result.ok) {
    return tailErrorToResponse(result.error);
  }

  const entries: ConsoleEntry[] = result.entries.map(
    (e): ConsoleEntry =>
      ({
        ...e,
        cursor: encodeCursor({
          sessionId: e.sessionId,
          sequenceNumber: e.sequenceNumber,
        }),
      }) as unknown as ConsoleEntry,
  );

  const nextSteps: string[] = [
    `Returned ${entries.length} ConsoleEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry carries page-world fields (ts, frameUrl, frameKey, level, args, optional stack) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor).`,
  ];
  if (result.hasMore) {
    nextSteps.push(
      `hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`,
    );
  } else if (result.cursor === null) {
    nextSteps.push(
      'No console events match the current filter; cursor is null. Adjust filter (level / pattern) or wait for new events.',
    );
  } else {
    nextSteps.push(
      'Latest tail returned (hasMore=false). To poll for new events as they arrive, retry with filter.since=cursor (top-level field of this response).',
    );
  }
  nextSteps.push(FILTER_SPEC_HINT);

  return okResponse(
    { entries, cursor: result.cursor, hasMore: result.hasMore },
    nextSteps,
  );
};

export const consoleTailTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'console_tail',
  description:
    "Tail the host-side console ring buffer for a target extension with cursor pagination + FilterSpec. Returns { entries: ConsoleEntry[]; cursor: Cursor|null; hasMore: bool }. Each ConsoleEntry has page-world fields (ts, frameUrl, frameKey, level, args, optional stack) intersected with host fields (receivedAt, sessionId, extensionId, sequenceNumber) plus a per-entry cursor. Top-level cursor = newest entry's cursor for forward pagination via filter.since. With no extension_id, targets the single connected NMH (errors if zero or multiple). FilterSpec (all optional): level=ConsoleLevel[] (log|info|warn|error|debug|trace); pattern={include?: regex sources[], exclude?: regex sources[]}; since/until=opaque cursor strings; limit=int 1..1000 (default 200). Errors carry kind in next_steps so AI can self-correct: cursor_invalid, cursor_session_mismatch, pattern_invalid, limit_invalid.",
  inputSchema,
  handler: consoleTailHandler,
});
