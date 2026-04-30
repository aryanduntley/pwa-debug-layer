import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import type { IpcRequestEnvelope } from '../ipc/envelope.js';
import { resolveTarget } from './target_resolution.js';

const RECENT_EVENTS_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  kinds: z.array(z.string()).optional(),
  since_ms: z.number().optional(),
  limit: z.number().int().nonnegative().optional(),
};

type RecentEventsPayload =
  | {
      readonly events?: readonly unknown[];
      readonly stats?: {
        readonly totalReceived?: number;
        readonly perKind?: Readonly<Record<string, number>>;
        readonly bufferSize?: number;
      };
    }
  | undefined;

const readPayload = (raw: unknown): RecentEventsPayload => {
  if (raw === null || typeof raw !== 'object') return undefined;
  return raw as RecentEventsPayload;
};

export const recentEventsHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions so Chrome respawns the NMH.',
    ]);
  }

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'recent_events',
    extensionId: target.extensionId,
    payload: {
      ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
      ...(args.since_ms !== undefined ? { sinceMs: args.since_ms } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    },
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: RECENT_EVENTS_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(
      `recent_events failed: ${(err as Error).message}`,
      [
        'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console and confirm the SW is connected to the host. If the SW responder is missing the recent_events handler, the request will time out.',
      ],
    );
  }

  if (response.error) {
    return errorResponse(
      `recent_events nmh error: ${response.error.message}`,
      [
        'NMH-mode rejected the request. Inspect the extension service worker console and the host stderr for the underlying error.',
      ],
    );
  }

  const payload = readPayload(response.payload);
  const events: readonly unknown[] = Array.isArray(payload?.events)
    ? payload!.events
    : [];
  const stats = payload?.stats ?? {
    totalReceived: 0,
    perKind: {},
    bufferSize: 0,
  };

  const data = {
    extensionId: target.extensionId,
    events,
    stats,
  };

  const nextSteps: string[] = [
    "Recent events from the SW ring buffer (in-memory, lost on SW restart). The buffer is populated by page-world capture producers (console now; fetch/XHR/WebSocket land in M9 Task 8). M11 will replace this in-memory buffer with host-side persistence so events survive SW restarts and tab reloads.",
  ];
  if (events.length === 0) {
    nextSteps.push(
      "events:[] — possible causes: (1) the page hasn't generated any captured activity since the SW started — try console.log on a page; (2) the SW restarted recently and the in-memory buffer was reset; (3) the page tab predates the most recent extension reload and content_scripts haven't injected — hard-refresh the tab and call session_ping to confirm the page-bridge half is healthy before retrying.",
    );
  }

  return okResponse(data, nextSteps);
};

export const recentEventsTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'recent_events',
  description:
    "Returns recent CapturedEvents from the extension's SW-side ring buffer (in-memory, lost on SW restart; M11 will add cross-restart persistence). Each event has shape: { kind, ts, frameUrl, frameKey, ...kind-specific-fields } where kind is 'console' (currently) or 'fetch'/'xhr'/'websocket' (M9 Task 8). Filters: kinds=['console','fetch'] restricts to listed kinds; since_ms is a strict greater-than ts cutoff; limit caps the result to the most-recent N (default 50, hard max = SW bufferSize). Returns { extensionId, events, stats: { totalReceived, perKind, bufferSize } }. With no extension_id, targets the single connected NMH (errors if zero or multiple). CALL host_status FIRST to see which extensions are connected, and session_ping to confirm the page-bridge half is healthy on the active tab.",
  inputSchema,
  handler: recentEventsHandler,
});
