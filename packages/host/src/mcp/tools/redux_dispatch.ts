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

const REDUX_DISPATCH_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  action: z.object({
    type: z.string().min(1),
    payload: z.unknown().optional(),
  }),
};

type DispatchSuccessPayload = {
  readonly dispatched: true;
  readonly action: { readonly type: string; readonly payload?: unknown };
  readonly scopeUrl: string;
};

type DispatchToolErrorPayload = {
  readonly error: { readonly message: string };
};

const isToolErrorPayload = (v: unknown): v is DispatchToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  const e = r['error'] as Record<string, unknown>;
  return typeof e['message'] === 'string';
};

const isDispatchSuccess = (v: unknown): v is DispatchSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r['dispatched'] === true && typeof r['scopeUrl'] === 'string';
};

export const reduxDispatchHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  // Setting gate FIRST — never even build an IPC envelope if disabled.
  const allowed = ctx.settingsStore.getSetting('capture.stores.allowDispatch');
  if (allowed !== true) {
    return errorResponse(
      'redux_dispatch is disabled (capture.stores.allowDispatch=false).',
      [
        "Enable writes via settings.set { key: 'capture.stores.allowDispatch', value: true } and retry. Default false because dispatching mutates user-visible application state; only opt in when intentionally driving the app from the AI side.",
      ],
    );
  }

  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { action: args.action };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'redux_dispatch',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: REDUX_DISPATCH_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`redux_dispatch failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect).',
    ]);
  }

  if (response.error) {
    return errorResponse(`redux_dispatch nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`redux_dispatch: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler. Common causes: no Redux store detected; malformed action; store.dispatch threw (e.g. an unknown action.type slipped through a stricter user reducer).',
    ]);
  }

  if (!isDispatchSuccess(response.payload)) {
    return errorResponse(
      'redux_dispatch returned a malformed payload (missing dispatched/scopeUrl).',
      [
        'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts reduxDispatchHandler.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...response.payload,
  };

  return okResponse(data, [
    'Action dispatched. Call redux_get_state (optionally with a path) to verify the post-state, or redux_tail to read the resulting store_change events if redux_subscribe is active.',
  ]);
};

export const reduxDispatchTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'redux_dispatch',
  description:
    "DEPRECATED — prefer store_dispatch (unified, framework auto-detect). Dispatch an action into the active Redux store (the only WRITE surface in the store-introspection family). DISABLED BY DEFAULT — opt in via settings.set { key: 'capture.stores.allowDispatch', value: true }. Args: { extension_id?, tab_id?, action: { type: non-empty string; payload? } }. Returns { extensionId, tabId, dispatched: true, action, scopeUrl } on success. Tool-level errors (no store detected; user reducer threw) follow the same { error: { message } } convention as redux_get_state. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: reduxDispatchHandler,
});
