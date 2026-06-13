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

// The SW waits up to timeout_ms (capped below) for the page to finish loading
// before replying, so the IPC budget must comfortably exceed it.
const NAV_MAX_LOAD_TIMEOUT_MS = 12_000;
const NAV_IPC_TIMEOUT_MS = NAV_MAX_LOAD_TIMEOUT_MS + 3_000;

const navigateInputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  url: z.string().min(1),
  timeout_ms: z.number().int().positive().max(NAV_MAX_LOAD_TIMEOUT_MS).optional(),
};

const newTabInputSchema = {
  extension_id: z.string().min(1).optional(),
  url: z.string().min(1),
  active: z.boolean().optional(),
  timeout_ms: z.number().int().positive().max(NAV_MAX_LOAD_TIMEOUT_MS).optional(),
};

/**
 * Shared IPC round-trip for the navigation tools: resolve the target NMH, send a
 * single request envelope to the SW, and normalize transport vs. handler errors.
 * The SW handler (request_router) drives chrome.tabs and waits for load-complete.
 */
const sendNavRequest = async (
  ctx: ToolContext,
  extensionId: string | undefined,
  tool: 'pdl_navigate' | 'pdl_new_tab',
  payload: Record<string, unknown>,
  nextSteps: readonly string[],
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, extensionId);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the extension reloaded at chrome://extensions.',
    ]);
  }

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool,
    extensionId: target.extensionId,
    payload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: NAV_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`${tool} failed: ${(err as Error).message}`, [
      `IPC request did not complete. Confirm the SW is connected and the ${tool} handler is wired in the SW.`,
    ]);
  }

  if (response.error) {
    return errorResponse(`${tool} nmh error: ${response.error.message}`, [
      'The SW rejected the navigation (invalid URL, no active tab, or chrome.tabs threw). Pass an explicit tab_id, or open a tab first.',
    ]);
  }

  const data = {
    extensionId: target.extensionId,
    ...(response.payload as object),
  };
  return okResponse(data, [...nextSteps]);
};

export const navigateHandler = async (
  args: z.infer<z.ZodObject<typeof navigateInputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> =>
  sendNavRequest(
    ctx,
    args.extension_id,
    'pdl_navigate',
    {
      url: args.url,
      ...(args.tab_id !== undefined ? { tab_id: args.tab_id } : {}),
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
    },
    [
      'Navigated the active (or given) tab. Returns { tabId, url, status }: status "complete" = page finished loading; "loading" = navigation happened but the load was still in flight when the wait elapsed (raise timeout_ms, or poll session_ping). pwa-debug capture/inspection tools now target the new page.',
    ],
  );

export const newTabHandler = async (
  args: z.infer<z.ZodObject<typeof newTabInputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> =>
  sendNavRequest(
    ctx,
    args.extension_id,
    'pdl_new_tab',
    {
      url: args.url,
      ...(args.active !== undefined ? { active: args.active } : {}),
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
    },
    [
      'Opened a new tab. Returns { tabId, url, status, created:true }. Pass the returned tabId to other pwa-debug tools (react_tree, console_tail, pdl_click, …) to target this tab; without tab_id they use the active tab.',
    ],
  );

export const navigateTool: ToolDef<typeof navigateInputSchema> = Object.freeze({
  name: 'pdl_navigate',
  description:
    "Navigate a browser tab to a URL, driven through the pwa-debug extension's service worker (chrome.tabs.update) — NO CDP, so it works on the user's real, logged-in profile without chrome-devtools-mcp being registered or attached. Targets the active tab in the last-focused window unless tab_id is given. The URL may omit the scheme (https:// is assumed); a javascript: URL is rejected. Waits for the page to reach document 'complete' (up to timeout_ms, default 10000, max 12000) before returning { extensionId, tabId, url, status, windowId? }, where status is 'complete' or 'loading' (load still in flight at timeout — the navigation still happened). Args: { url: non-empty string, tab_id?, timeout_ms?, extension_id? }. With no extension_id/tab_id, targets the single connected NMH and the active tab. CALL host_status FIRST to confirm a connection.",
  inputSchema: navigateInputSchema,
  handler: navigateHandler,
});

export const newTabTool: ToolDef<typeof newTabInputSchema> = Object.freeze({
  name: 'pdl_new_tab',
  description:
    "Open a NEW browser tab at a URL via the pwa-debug extension's service worker (chrome.tabs.create) — NO CDP, works on the user's real profile with no chrome-devtools-mcp dependency. The URL may omit the scheme (https:// is assumed); a javascript: URL is rejected. active? controls foreground vs. background (defaults to foreground). Waits for the page to reach document 'complete' (up to timeout_ms, default 10000, max 12000) before returning { extensionId, tabId, url, status, windowId?, created:true }. Pass the returned tabId to other pwa-debug tools to target this tab specifically. Args: { url: non-empty string, active?, timeout_ms?, extension_id? }. With no extension_id, targets the single connected NMH. CALL host_status FIRST to confirm a connection.",
  inputSchema: newTabInputSchema,
  handler: newTabHandler,
});
