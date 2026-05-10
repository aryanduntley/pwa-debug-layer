import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { resolveTarget } from './target_resolution.js';
import type { CapturesInStats } from '../../captures_in/captures_in.js';

const inputSchema = {
  extension_id: z.string().min(1).optional(),
};

const ZERO_PER_KIND = Object.freeze({
  console: Object.freeze({ received: 0, dropped: 0, size: 0 }),
  network: Object.freeze({ received: 0, dropped: 0, size: 0 }),
  dom_mutations: Object.freeze({ received: 0, dropped: 0, size: 0 }),
  lifecycle: Object.freeze({ received: 0, dropped: 0, size: 0 }),
});

const NO_EVENTS_SESSION = 'no-events-yet';

const buildZeroStats = (extensionId: string): CapturesInStats =>
  Object.freeze({
    perKind: ZERO_PER_KIND,
    droppedUnknown: 0,
    totals: Object.freeze({ received: 0, dropped: 0 }),
    sessionId: NO_EVENTS_SESSION,
    extensionId,
  });

export const captureDebugStatsHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions so Chrome respawns the NMH.',
    ]);
  }

  const captures = ctx.capturesRegistry.get(target.extensionId);
  const stats: CapturesInStats =
    captures !== undefined
      ? captures.getStats()
      : buildZeroStats(target.extensionId);

  const nextSteps: string[] = [
    "TEMPORARY M11 tool — will be replaced by Path 2 M4's console.tail and network.tail (real cursor-paginated tail tools). Use this only for verifying that page-world capture producers are reaching the host buffers end-to-end.",
    'perKind.<bucket>.received counts events that landed in the host buffer; .dropped counts per-kind validation failures (recognized kind but bad ts); .size is the current ring-buffer fill (capped at capacityPerKind, default 5000).',
    'droppedUnknown counts events with missing/non-string kind, unrecognized kind, or non-object payload — these never reach a per-kind bucket.',
  ];
  if (stats.sessionId === NO_EVENTS_SESSION) {
    nextSteps.push(
      `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet. Confirm a tab is open with the extension active and trigger some console.log / fetch activity, then retry. The CapturesIn instance is created lazily on first event.`,
    );
  }

  return okResponse(stats, nextSteps);
};

export const captureDebugStatsTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'capture_debug_stats',
  description:
    "TEMPORARY M11 tool — exposes the host-side CapturesIn ring-buffer stats per extension so AI can verify the page-world → CS → SW → IPC → host buffer dispatch chain end-to-end. Returns { perKind: { console, network, dom_mutations, lifecycle: { received, dropped, size } }, droppedUnknown, totals: { received, dropped }, sessionId, extensionId }. With no extension_id, targets the single connected NMH (errors if zero or multiple). When the targeted extension is connected but the host hasn't received any captures-flavor events yet, returns zero-stats with sessionId='no-events-yet' rather than an error. CALL host_status FIRST to confirm activeConnections. Will be removed when Path 2 M4 ships console.tail and network.tail (real tail tools).",
  inputSchema,
  handler: captureDebugStatsHandler,
});
