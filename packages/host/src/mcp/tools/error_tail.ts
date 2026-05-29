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
import { encodeCursor, type PageErrorEntry } from '@pwa-debug/shared';
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

export const errorTailHandler = async (
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
    return okResponse({ entries: [], cursor: null, hasMore: false }, [
      `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Uncaught errors / unhandled promise rejections land here once they fire on a page.`,
      FILTER_SPEC_HINT,
    ]);
  }

  const sessionId = captures.getStats().sessionId;
  const result = await tailWithFilterMerged({
    buffer: captures.buffer('page_error'),
    spec: toFilterSpec(args.filter),
    ctx: { currentSessionId: sessionId },
    kind: 'page_error',
  });

  if (!result.ok) {
    return tailErrorToResponse(result.error);
  }

  const entries: PageErrorEntry[] = result.entries.map(
    (e): PageErrorEntry =>
      ({
        ...e,
        cursor: encodeCursor({
          sessionId: e.sessionId,
          sequenceNumber: e.sequenceNumber,
        }),
      }) as unknown as PageErrorEntry,
  );

  const nextSteps: string[] = [
    `Returned ${entries.length} PageErrorEntry record(s) for extension ${target.extensionId} (host session ${sessionId}). Each entry is an uncaught failure: subkind='error' (window 'error'/window.onerror) or 'unhandledrejection' (a rejected promise the app did not catch), plus message, name?, stack?, source? (url:line:col) and page-world fields (ts, frameUrl, frameKey) + host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). These are errors that BUBBLED — failures an app fully catches in try/catch won't appear here.`,
  ];
  if (result.hasMore) {
    nextSteps.push(
      'hasMore=true: page forward by passing the response top-level cursor as filter.since.',
    );
  } else if (result.cursor === null) {
    nextSteps.push(
      'No page errors match the current filter. If you set filter.level, drop it (page errors have no console-level field). Otherwise trigger/await an uncaught error or unhandled rejection.',
    );
  } else {
    nextSteps.push(
      'Latest tail returned (hasMore=false). Poll for new errors with filter.since=cursor.',
    );
  }
  nextSteps.push(FILTER_SPEC_HINT);

  return okResponse(
    { entries, cursor: result.cursor, hasMore: result.hasMore },
    nextSteps,
  );
};

export const errorTailTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'error_tail',
  description:
    "Tail the host-side page_error ring buffer for a target extension with cursor pagination + FilterSpec. page_error events are UNCAUGHT failures captured app-/framework-agnostically: a window 'error' (ErrorEvent / window.onerror, subkind='error') or an 'unhandledrejection' (a rejected promise the app did not catch, subkind='unhandledrejection'). Returns { entries: PageErrorEntry[]; cursor: Cursor|null; hasMore: bool }. Each entry: { kind:'page_error', subkind, message, name?, stack?, source?(url:line:col), ts, frameUrl, frameKey, ...host fields, cursor }. Use this to see thrown errors and rejected promises (including wallet/connect rejections that bubble) without the app having to log them. NOTE: errors an app fully handles in try/catch do NOT surface here. With no extension_id, targets the single connected NMH (errors if zero or multiple). FilterSpec (all optional): pattern.include/exclude=regex sources matched against each entry's JSON (e.g. include:['rejected','cancelled']); since/until=opaque cursors; limit=int 1..1000 (default 200); level is ignored (page errors have no level field).",
  inputSchema,
  handler: errorTailHandler,
});
