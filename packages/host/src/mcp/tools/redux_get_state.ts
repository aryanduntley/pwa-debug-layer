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

const REDUX_GET_STATE_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  path: z.string().min(1).optional(),
};

type StoreSuccessPayload = {
  readonly state: unknown;
  readonly path?: string;
  readonly truncated?: boolean;
  readonly scopeUrl: string;
};

type StoreToolErrorPayload = {
  readonly error: { readonly message: string };
};

const isToolErrorPayload = (v: unknown): v is StoreToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  const e = r['error'] as Record<string, unknown>;
  return typeof e['message'] === 'string';
};

const isStoreSuccess = (v: unknown): v is StoreSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return 'state' in r && typeof r['scopeUrl'] === 'string';
};

export const reduxGetStateHandler = async (
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
  if (args.path !== undefined) wirePayload['path'] = args.path;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'redux_get_state',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: REDUX_GET_STATE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`redux_get_state failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the redux_get_state handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`redux_get_state nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`redux_get_state: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler. Common causes: no Redux store detected on the page (the fixture must expose it via window.__pwaDebug_redux, or T2 production-style detection via the __REDUX_DEVTOOLS_EXTENSION__ shim must be in place); malformed path; descent into a primitive.',
    ]);
  }

  if (!isStoreSuccess(response.payload)) {
    return errorResponse(
      'redux_get_state returned a malformed payload (missing state/scopeUrl).',
      [
        'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts redux_get_state branch.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...response.payload,
  };

  const nextSteps: string[] = [
    'Store value shape: { extensionId, tabId, state, path?, truncated?, scopeUrl }. The state field is the live store snapshot, optionally pruned to the path argument. truncated:true means the snapshot exceeded the 16KB serializer cap — pass a path to narrow it.',
  ];
  if (response.payload.truncated === true) {
    nextSteps.push(
      'truncated:true — the returned value exceeded the 16KB serializer cap and was replaced with a {__type:"Truncated", approxSize, max} placeholder. Re-call with a narrower path argument (e.g., counter.value) to retrieve a smaller slice.',
    );
  }

  return okResponse(data, nextSteps);
};

export const reduxGetStateTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'redux_get_state',
  description:
    "Return the current Redux store state from the active tab, optionally pruned to a dotted/bracket path. Args: { extension_id?, tab_id?, path?: 'counter.value' | 'todos[0].text' | \"users['by-id']\" }. Returns { extensionId, tabId, state, path?, truncated?, scopeUrl }. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: reduxGetStateHandler,
});
