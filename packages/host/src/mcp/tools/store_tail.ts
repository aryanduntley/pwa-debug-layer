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
import { encodeCursor, type StoreChangeEntry } from '@pwa-debug/shared';
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

export const storeTailHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension.',
      FILTER_SPEC_HINT,
    ]);
  }

  const captures = ctx.capturesRegistry.get(target.extensionId);
  if (captures === undefined) {
    return okResponse(
      { entries: [], cursor: null, hasMore: false },
      [
        `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Call store_subscribe(action="start") first, then mutate the store in the page to produce store_change events.`,
        FILTER_SPEC_HINT,
      ],
    );
  }

  const sessionId = captures.getStats().sessionId;
  const storeBuffer = captures.buffer('store_change');
  const filterSpec = toFilterSpec(args.filter);
  const result = await tailWithFilterMerged({
    buffer: storeBuffer,
    spec: filterSpec,
    ctx: { currentSessionId: sessionId },
    kind: 'store_change',
  });

  if (!result.ok) {
    return tailErrorToResponse(result.error);
  }

  const entries: StoreChangeEntry[] = result.entries.map(
    (e): StoreChangeEntry =>
      ({
        ...e,
        cursor: encodeCursor({
          sessionId: e.sessionId,
          sequenceNumber: e.sequenceNumber,
        }),
      }) as unknown as StoreChangeEntry,
  );

  const nextSteps: string[] = [
    `Returned ${entries.length} StoreChangeEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry carries page-world fields (ts, frameUrl, frameKey, storeId, framework?, path?, diff, snapshot, truncated?) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). framework names the store library that produced the event.`,
  ];
  if (result.hasMore) {
    nextSteps.push(
      `hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`,
    );
  } else if (result.cursor === null) {
    nextSteps.push(
      'No store_change events match the current filter; cursor is null. Confirm store_subscribe(action="start") is active and at least one store change has occurred.',
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

export const storeTailTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'store_tail',
  description:
    "Tail the host-side store_change ring buffer (populated while store_subscribe is active) for a target extension. Framework-agnostic: each entry's framework field names the store library that produced it. Returns { entries: StoreChangeEntry[]; cursor: Cursor|null; hasMore: bool }. Each StoreChangeEntry carries page-world fields (ts, frameUrl, frameKey, storeId, framework?, path?, diff{added, changed, removed}, snapshot, truncated?) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). FilterSpec (all optional): pattern={include?: regex sources[], exclude?: regex sources[]}; since/until=opaque cursor strings; limit=int 1..1000 (default 200). level is ignored (store_change has no console-level field). Call store_subscribe(action='start') first to start producing events.",
  inputSchema,
  handler: storeTailHandler,
});
