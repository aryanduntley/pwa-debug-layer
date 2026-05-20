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
import { encodeCursor, type ReplayEntry } from '@pwa-debug/shared';
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

export const sessionReplayHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called.',
      FILTER_SPEC_HINT,
    ]);
  }

  const captures = ctx.capturesRegistry.get(target.extensionId);
  if (captures === undefined) {
    return okResponse(
      { entries: [], cursor: null, hasMore: false },
      [
        `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Call session_record(action="start") first.`,
        FILTER_SPEC_HINT,
      ],
    );
  }

  const sessionId = captures.getStats().sessionId;
  const replayBuffer = captures.buffer('replay');
  const filterSpec = toFilterSpec(args.filter);
  const result = await tailWithFilterMerged({
    buffer: replayBuffer,
    spec: filterSpec,
    ctx: { currentSessionId: sessionId },
    kind: 'replay',
  });

  if (!result.ok) {
    return tailErrorToResponse(result.error);
  }

  const entries: ReplayEntry[] = result.entries.map(
    (e): ReplayEntry =>
      ({
        ...e,
        cursor: encodeCursor({
          sessionId: e.sessionId,
          sequenceNumber: e.sequenceNumber,
        }),
      }) as unknown as ReplayEntry,
  );

  const nextSteps: string[] = [
    `Returned ${entries.length} ReplayEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry carries page-world fields (ts, frameUrl, frameKey, sessionId, rrwebType, data, timestamp) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor).`,
  ];
  if (result.hasMore) {
    nextSteps.push(
      `hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`,
    );
  } else if (result.cursor === null) {
    nextSteps.push(
      'No replay events match the current filter; cursor is null. Confirm session_record(action="start") is active and the page has produced rrweb events.',
    );
  } else {
    nextSteps.push(
      'Latest tail returned (hasMore=false). To poll for new events, retry with filter.since=cursor (top-level field of this response).',
    );
  }
  nextSteps.push(FILTER_SPEC_HINT);

  return okResponse(
    { entries, cursor: result.cursor, hasMore: result.hasMore },
    nextSteps,
  );
};

export const sessionReplayTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'session_replay',
  description:
    "Tail the host-side replay ring buffer (populated while session_record is active) for a target extension. Returns { entries: ReplayEntry[]; cursor; hasMore }. Each ReplayEntry carries page-world fields (ts, frameUrl, frameKey, sessionId, rrwebType, data, timestamp) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). FilterSpec: pattern (regex over JSON.stringify), since/until cursors, limit. level is ignored. Call session_record(action='start') first to start producing events.",
  inputSchema,
  handler: sessionReplayHandler,
});
