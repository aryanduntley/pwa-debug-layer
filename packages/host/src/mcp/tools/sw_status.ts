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
import type { SwStatusSnapshot, SwWorkerRecord } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const SW_STATUS_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
};

const isWorkerRecord = (v: unknown): v is SwWorkerRecord => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['scriptURL'] === 'string' && typeof r['state'] === 'string';
};

const readSnapshot = (raw: unknown): SwStatusSnapshot | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['supported'] !== 'boolean') return null;
  if (typeof r['hasWaitingUpdate'] !== 'boolean') return null;
  if (!Array.isArray(r['registrations'])) return null;
  const controller = r['controller'];
  if (controller !== null && !isWorkerRecord(controller)) return null;
  return raw as SwStatusSnapshot;
};

export const swStatusHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension so Chrome respawns the NMH.',
    ]);
  }

  const wirePayload: Record<string, unknown> = {};
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: 'sw_status',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SW_STATUS_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`sw_status failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console and confirm the SW is connected to the host.',
    ]);
  }

  if (response.error) {
    return errorResponse(`sw_status nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab (open an http(s) tab to the PWA), explicit tab_id not found, or the page-world bridge is not attached (chrome:// / web-store pages cannot be read).',
    ]);
  }

  const snapshot = readSnapshot(response.payload);
  if (snapshot === null) {
    return errorResponse(
      'sw_status returned a malformed payload (missing supported/registrations/hasWaitingUpdate).',
      [
        'The page-world handler returned a shape that does not match SwStatusSnapshot. Check packages/extension/src/sw_app/projection.ts and the page_dispatch sw_status handler.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...snapshot,
  };

  const nextSteps: string[] = [
    'SwStatusSnapshot: { supported, controller, registrations[], hasWaitingUpdate }. Each registration has { scope, updateViaCache, installing, waiting, active, activeScriptURL, hasWaitingUpdate }. controller is the worker currently driving the page.',
  ];
  if (!snapshot.supported) {
    nextSteps.push(
      'supported:false — navigator.serviceWorker is absent here (insecure context / unsupported browser). The page cannot use service workers at this origin.',
    );
  } else if (snapshot.registrations.length === 0) {
    nextSteps.push(
      'No service worker is registered for this scope. If you expected one, the app may not have called navigator.serviceWorker.register() yet, or the SW failed to install (check console_tail / error_tail).',
    );
  }
  if (snapshot.hasWaitingUpdate) {
    nextSteps.push(
      'hasWaitingUpdate:true — a new worker is installed and WAITING (the page keeps running the active worker until all clients close or the SW calls skipWaiting). This is the classic "my update is not showing" state. Inspect registrations[].waiting; the fix is skipWaiting() + clients.claim() or closing every tab/window of the app.',
    );
  }
  if (snapshot.supported && snapshot.controller === null) {
    nextSteps.push(
      'controller:null — no worker is controlling the page. Normal on the very first load before activation, or after a shift-reload (which bypasses the SW). A hard navigation should let the active worker take control.',
    );
  }

  return okResponse(data, nextSteps);
};

export const swStatusTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'sw_status',
  description:
    "Inspect the DEBUGGED PWA's service worker(s). Returns SwStatusSnapshot { supported, controller, registrations[], hasWaitingUpdate } read from the page's navigator.serviceWorker — the installing/waiting/active worker for each registration (with script URLs + lifecycle state), which worker controls the page, and whether an update is stuck WAITING (the #1 'why isn't my update showing' signal). Reads the app's real SW state in your actual browser profile — something CDP / chrome-devtools-mcp does not surface. Args: { extension_id?, tab_id? }. Runs in page-world via the page-bridge (no CDP). For the lifecycle event stream (updatefound/statechange/controllerchange) use sw_lifecycle_tail. CALL host_status FIRST to see connected extensions.",
  inputSchema,
  handler: swStatusHandler,
});
