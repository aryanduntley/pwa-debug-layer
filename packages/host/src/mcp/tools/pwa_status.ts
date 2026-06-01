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
import type { PwaStatusSnapshot } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const PWA_STATUS_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
};

const readResult = (raw: unknown): PwaStatusSnapshot | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['displayMode'] !== 'string') return null;
  if (typeof r['standalone'] !== 'boolean') return null;
  if (typeof r['controlledBySW'] !== 'boolean') return null;
  if (r['permissions'] === null || typeof r['permissions'] !== 'object') return null;
  if (r['capabilities'] === null || typeof r['capabilities'] !== 'object') return null;
  return raw as PwaStatusSnapshot;
};

export const pwaStatusHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
    ]);
  }

  const wirePayload: Record<string, unknown> = {};
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: 'pwa_status',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: PWA_STATUS_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`pwa_status failed: ${(err as Error).message}`, [
      'IPC request did not complete. Check the extension service worker console and confirm the SW is connected.',
    ]);
  }
  if (response.error) {
    return errorResponse(`pwa_status nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('pwa_status returned a malformed payload.', [
      'The page-world handler returned a shape that does not match PwaStatusSnapshot. Check packages/extension/src/pwa_status/read.ts.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'PwaStatusSnapshot: { displayMode, standalone, controlledBySW, controllerScriptURL, permissions: { notifications, push, periodicBackgroundSync }, capabilities: { serviceWorker, pushManager, backgroundSync, periodicBackgroundSync, badging, fileSystemAccess, windowControlsOverlay, webShare, notifications } }. capabilities are live feature-detection (is the API present in THIS browser); permissions are the Permissions-API state.',
  ];
  if (!result.standalone) {
    nextSteps.push(
      'standalone:false — running as a normal browser tab, not an installed app. For why it may not be installable, use pwa_installability (when available) or check the manifest + service worker.',
    );
  }
  if (!result.controlledBySW) {
    nextSteps.push(
      'controlledBySW:false — no service worker controls the page (first load before activation, hard-reload, or none registered). See sw_status for registration detail.',
    );
  }

  return okResponse(data, nextSteps);
};

export const pwaStatusTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'pwa_status',
  description:
    "Snapshot the debugged PWA's runtime status + capability matrix. Returns PwaStatusSnapshot { displayMode, standalone (installed?), controlledBySW + controllerScriptURL, permissions: { notifications, push, periodicBackgroundSync }, capabilities: { serviceWorker, pushManager, backgroundSync, periodicBackgroundSync, badging, fileSystemAccess, windowControlsOverlay, webShare, notifications } }. capabilities = live feature-detection in THIS browser (answers 'why does push work on Android but not here'); permissions = current Permissions-API grants. One cheap call assembles what DevTools makes you gather piecemeal. Reads your real profile. Args: { extension_id?, tab_id? }. Page-world read. CALL host_status FIRST.",
  inputSchema,
  handler: pwaStatusHandler,
});
