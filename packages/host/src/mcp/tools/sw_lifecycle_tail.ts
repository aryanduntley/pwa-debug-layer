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
import { encodeCursor, type SwStateEntry } from '@pwa-debug/shared';
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

export const swLifecycleTailHandler = async (
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
    return okResponse({ entries: [], cursor: null, hasMore: false }, [
      `Extension ${target.extensionId} is connected but no captured events have arrived yet. The CapturesIn instance is created lazily on first event — service-worker lifecycle events only fire on transitions (an update installing, a state change, a controller change), so a stable app may emit none. Use sw_status for a point-in-time snapshot instead.`,
      FILTER_SPEC_HINT,
    ]);
  }

  const sessionId = captures.getStats().sessionId;
  const buffer = captures.buffer('sw_state');
  const filterSpec = toFilterSpec(args.filter);
  const result = await tailWithFilterMerged({
    buffer,
    spec: filterSpec,
    ctx: { currentSessionId: sessionId },
    kind: 'sw_state',
  });

  if (!result.ok) {
    return tailErrorToResponse(result.error);
  }

  const entries: SwStateEntry[] = result.entries.map(
    (e): SwStateEntry =>
      ({
        ...e,
        cursor: encodeCursor({
          sessionId: e.sessionId,
          sequenceNumber: e.sequenceNumber,
        }),
      }) as unknown as SwStateEntry,
  );

  const nextSteps: string[] = [
    `Returned ${entries.length} SwStateEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry has { subkind, scope?, scriptURL?, state?, slot? } plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). subkind: 'updatefound' (a new worker began installing), 'statechange' (a worker advanced installing→installed→activating→activated→redundant), 'controllerchange' (a new worker took control of the page). For the current snapshot (waiting/active/controller) call sw_status.`,
  ];
  if (result.hasMore) {
    nextSteps.push(
      'hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.',
    );
  } else if (result.cursor === null) {
    nextSteps.push(
      "No sw_state events captured yet. They only fire on lifecycle transitions — trigger one (deploy a new SW, or reload to install an update), or the app may have a stable, already-activated worker. sw_status shows the steady-state snapshot.",
    );
  } else {
    nextSteps.push(
      'Latest tail returned (hasMore=false). To watch for new transitions as they happen, retry with filter.since=cursor (top-level field of this response).',
    );
  }
  nextSteps.push(FILTER_SPEC_HINT);

  return okResponse(
    { entries, cursor: result.cursor, hasMore: result.hasMore },
    nextSteps,
  );
};

export const swLifecycleTailTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'sw_lifecycle_tail',
  description:
    "Tail the DEBUGGED PWA's service-worker lifecycle event stream (kind 'sw_state') with cursor pagination + FilterSpec. Returns { entries: SwStateEntry[]; cursor: Cursor|null; hasMore: bool }. Each SwStateEntry: { subkind, scope?, scriptURL?, state?, slot? } + host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). subkind: 'updatefound' = a new worker started installing; 'statechange' = a worker advanced lifecycle state (installing→installed→activating→activated→redundant); 'controllerchange' = the page's controlling worker changed. This is the EVENT STREAM (transitions over time) — for the point-in-time snapshot (waiting/active/controller, hasWaitingUpdate) use sw_status. Captured in page-world against your real profile; CDP/chrome-devtools-mcp does not surface this. Events only fire on transitions, so a stable app may return none. With no extension_id, targets the single connected NMH. CALL host_status FIRST.",
  inputSchema,
  handler: swLifecycleTailHandler,
});
