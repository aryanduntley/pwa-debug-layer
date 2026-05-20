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
  type NetworkEntry,
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

export const networkTailHandler = async (
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
        `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. The CapturesIn instance is created lazily on first event — trigger fetch / XHR / WebSocket activity in a tab and retry.`,
        FILTER_SPEC_HINT,
      ],
    );
  }

  const sessionId = captures.getStats().sessionId;
  const networkBuffer = captures.buffer('network');
  const filterSpec = toFilterSpec(args.filter);
  const result = await tailWithFilterMerged({
    buffer: networkBuffer,
    spec: filterSpec,
    ctx: { currentSessionId: sessionId },
    kind: 'network',
  });

  if (!result.ok) {
    return tailErrorToResponse(result.error);
  }

  const entries: NetworkEntry[] = result.entries.map(
    (e): NetworkEntry =>
      ({
        ...e,
        cursor: encodeCursor({
          sessionId: e.sessionId,
          sequenceNumber: e.sequenceNumber,
        }),
      }) as unknown as NetworkEntry,
  );

  const nextSteps: string[] = [
    `Returned ${entries.length} NetworkEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry is discriminated by kind: 'fetch' (request/response/error phases, captureId, method, url, headers, status, body, durationMs), 'xhr' (same as fetch + responseType), or 'websocket' (subkind=open|frame|close|error, connectionId, url, direction, frameType, data, code, reason). All carry host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor).`,
  ];
  if (result.hasMore) {
    nextSteps.push(
      `hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`,
    );
  } else if (result.cursor === null) {
    nextSteps.push(
      'No network events match the current filter; cursor is null. If you set filter.level, note it does not apply to network events (none have a level field) — drop it. Otherwise adjust filter.pattern or wait for new events.',
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

export const networkTailTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'network_tail',
  description:
    "Tail the host-side network ring buffer (fetch + xhr + websocket events) for a target extension with cursor pagination + FilterSpec. Returns { entries: NetworkEntry[]; cursor: Cursor|null; hasMore: bool }. Each NetworkEntry is discriminated by kind: 'fetch' | 'xhr' (request/response/error phases correlated by captureId, with method, url, headers, status, body, durationMs; xhr adds responseType) | 'websocket' (subkind=open|frame|close|error, connectionId, url, direction=send|receive, frameType=text|binary, data, code, reason). All carry host fields (receivedAt, sessionId, extensionId, sequenceNumber) plus per-entry cursor. With no extension_id, targets the single connected NMH (errors if zero or multiple). FilterSpec (all optional): pattern={include?: regex sources[], exclude?: regex sources[]} matches against JSON.stringify of each entry; since/until=opaque cursor strings; limit=int 1..1000 (default 200); level applies only to console events and returns empty entries when set on the network buffer; selectors reserved for DOM tail tools. Errors carry kind in next_steps for AI self-correction.",
  inputSchema,
  handler: networkTailHandler,
});
