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

const REDUX_SUBSCRIBE_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  action: z.enum(['start', 'stop']),
  path: z.string().min(1).optional(),
};

type SubscribeSuccessPayload = {
  readonly active: boolean;
  readonly path?: string;
  readonly scopeUrl: string;
};

type SubscribeToolErrorPayload = {
  readonly error: { readonly message: string };
};

const isToolErrorPayload = (v: unknown): v is SubscribeToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  const e = r['error'] as Record<string, unknown>;
  return typeof e['message'] === 'string';
};

const isSubscribeSuccess = (v: unknown): v is SubscribeSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['active'] === 'boolean' && typeof r['scopeUrl'] === 'string';
};

export const reduxSubscribeHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { action: args.action };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.path !== undefined) wirePayload['path'] = args.path;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'redux_subscribe',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: REDUX_SUBSCRIBE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`redux_subscribe failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect).',
    ]);
  }

  if (response.error) {
    return errorResponse(`redux_subscribe nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`redux_subscribe: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler. Common causes: no Redux store detected; malformed path.',
    ]);
  }

  if (!isSubscribeSuccess(response.payload)) {
    return errorResponse(
      'redux_subscribe returned a malformed payload (missing active/scopeUrl).',
      [
        'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts reduxSubscribeHandler.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...response.payload,
  };

  const nextSteps: string[] = [];
  if (response.payload.active) {
    nextSteps.push(
      'Subscription active. Call redux_tail to read accumulated store_change events. Re-call redux_subscribe with action="start" + a new path to swap the subscription (idempotent re-config). Call action="stop" to tear it down.',
    );
  } else {
    nextSteps.push(
      'Subscription inactive. action="start" was not called or the most recent call was "stop".',
    );
  }

  return okResponse(data, nextSteps);
};

export const reduxSubscribeTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'redux_subscribe',
  description:
    "DEPRECATED — prefer store_subscribe (unified, framework auto-detect). Start or stop a Redux store subscription on the active tab. While active, each store.subscribe callback whose path-narrowed snapshot differs from the prior snapshot emits a store_change event that flows through the standard capture pipeline; read accumulated events via redux_tail. Args: { extension_id?, tab_id?, action: 'start' | 'stop', path?: 'counter' | 'todos.items' }. Returns { extensionId, tabId, active, path?, scopeUrl }. Single subscription per page-world; calling action='start' again replaces any prior subscription. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: reduxSubscribeHandler,
});
