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

const SESSION_PING_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
};

type ResolvedTarget =
  | { readonly ok: true; readonly extensionId: string }
  | { readonly ok: false; readonly error: string };

const resolveTarget = (
  ctx: ToolContext,
  argId: string | undefined,
): ResolvedTarget => {
  const conns = ctx.ipcServer.listConnections();
  if (argId !== undefined) {
    const found = conns.find((c) => c.extensionId === argId);
    if (!found) {
      return {
        ok: false,
        error: `no connected NMH for extension_id=${argId}`,
      };
    }
    return { ok: true, extensionId: argId };
  }
  if (conns.length === 0) {
    return { ok: false, error: 'no NMH connected' };
  }
  if (conns.length > 1) {
    return {
      ok: false,
      error: `multiple NMH connections (${conns.length}); pass extension_id explicitly`,
    };
  }
  return { ok: true, extensionId: conns[0]!.extensionId };
};

const readPayloadString = (payload: unknown, key: string): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
};

const readPayloadNumber = (payload: unknown, key: string): number | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : null;
};

export const sessionPingHandler = async (
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
    tool: 'session_ping',
    extensionId: target.extensionId,
    payload: {},
  });

  const startedAt = Date.now();
  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SESSION_PING_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`session_ping failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console for errors and confirm the SW is connected to the host. If the SW responder is missing the session_ping handler, the request will time out.',
    ]);
  }

  const latencyMs = Date.now() - startedAt;

  if (response.error) {
    return errorResponse(
      `session_ping nmh error: ${response.error.message}`,
      [
        'NMH-mode rejected the request. Inspect the extension service worker console and the host stderr for the underlying error.',
      ],
    );
  }

  const data = {
    hostVersion: ctx.hostVersion,
    extensionVersion: readPayloadString(response.payload, 'extensionVersion'),
    attachedTabId: readPayloadNumber(response.payload, 'attachedTabId'),
    extensionId: target.extensionId,
    latencyMs,
  };

  return okResponse(data, [
    'Round-trip MCP→IPC→NMH→SW completed. extensionVersion and attachedTabId reflect the SW response — if either is null, the SW responder may not yet implement that field.',
  ]);
};

export const sessionPingTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'session_ping',
  description:
    'Sends a ping through the full MCP → IPC → NMH → SW chain and returns the round-trip metadata: { hostVersion, extensionVersion, attachedTabId, extensionId, latencyMs }. With no args, targets the single connected NMH (errors if zero or multiple). Pass extension_id to target a specific extension. CALL host_status FIRST to see which extensions are currently connected.',
  inputSchema,
  handler: sessionPingHandler,
});
