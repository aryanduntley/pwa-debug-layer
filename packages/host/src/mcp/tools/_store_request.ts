/**
 * Shared host-side request helper for the unified store_* MCP tools (Path 4
 * M2). Centralizes the target-resolution + IPC request + standard error
 * mapping that store_get_state / store_subscribe / store_dispatch all repeat,
 * so each tool file stays a thin schema + payload-shaping + success-validation
 * orchestrator. The legacy redux_* tools are intentionally left on their own
 * inline boilerplate (no behavior change); future cleanup can migrate them.
 *
 * The optional `framework` selector is threaded into the wire payload only when
 * supplied — when absent, the page-world registry auto-detects the live store.
 */
import { randomUUID } from 'node:crypto';
import {
  errorResponse,
  type ToolContext,
  type ToolResponse,
} from '../tool_registry.js';
import type { IpcRequestEnvelope } from '../ipc/envelope.js';
import { resolveTarget } from './target_resolution.js';

const DEFAULT_STORE_IPC_TIMEOUT_MS = 5000;

export type StoreRequestArgs = {
  /** Human-facing tool name used in error messages (e.g. 'store_get_state'). */
  readonly toolName: string;
  /** Wire tool name routed through the SW + page-world (e.g. 'store_get_state'). */
  readonly wireTool: string;
  readonly extensionId?: string;
  readonly tabId?: number;
  readonly framework?: string;
  /** Tool-specific wire fields (path, action, …). tab_id/framework are merged in. */
  readonly payload?: Record<string, unknown>;
  readonly timeoutMs?: number;
};

export type StoreRequestResult =
  | {
      readonly ok: true;
      readonly payload: unknown;
      readonly extensionId: string;
      readonly tabId: number | null;
    }
  | { readonly ok: false; readonly response: ToolResponse };

const isToolErrorPayload = (
  v: unknown,
): v is { readonly error: { readonly message: string } } => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  const e = r['error'] as Record<string, unknown>;
  return typeof e['message'] === 'string';
};

/**
 * Resolve the target NMH, send the store tool's IPC request, and map every
 * failure mode (no connection, transport error, NMH-level error, page-world
 * tool-level error) to a ready-to-return errorResponse. On success returns the
 * raw page-world payload plus the resolved extensionId/tabId for the caller to
 * shape and validate.
 */
export const requestStoreTool = async (
  ctx: ToolContext,
  args: StoreRequestArgs,
): Promise<StoreRequestResult> => {
  const target = resolveTarget(ctx, args.extensionId);
  if (!target.ok) {
    return {
      ok: false,
      response: errorResponse(target.error, [
        'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
      ]),
    };
  }

  const wirePayload: Record<string, unknown> = { ...(args.payload ?? {}) };
  if (args.tabId !== undefined) wirePayload['tab_id'] = args.tabId;
  if (args.framework !== undefined) wirePayload['framework'] = args.framework;

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: args.wireTool,
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: args.timeoutMs ?? DEFAULT_STORE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return {
      ok: false,
      response: errorResponse(
        `${args.toolName} failed: ${(err as Error).message}`,
        [
          'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the store handler is wired in the SW.',
        ],
      ),
    };
  }

  if (response.error) {
    return {
      ok: false,
      response: errorResponse(
        `${args.toolName} nmh error: ${response.error.message}`,
        [
          'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
        ],
      ),
    };
  }

  if (isToolErrorPayload(response.payload)) {
    return {
      ok: false,
      response: errorResponse(`${args.toolName}: ${response.payload.error.message}`, [
        "Tool-level error from the page-world handler. Common causes: no supported store detected on the page (e.g. Redux on window.__pwaDebug_redux or via the __REDUX_DEVTOOLS_EXTENSION__ shim); a malformed path; or, when an explicit framework arg was passed, no adapter registered for that framework.",
      ]),
    };
  }

  return {
    ok: true,
    payload: response.payload,
    extensionId: target.extensionId,
    tabId: args.tabId ?? null,
  };
};
