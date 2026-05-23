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

const VUE_GET_STATE_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  stable_id: z.string().min(1),
  include_props: z.boolean().optional(),
  include_state: z.boolean().optional(),
};

type ComponentSuccessPayload = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly props?: unknown;
  readonly setupState?: unknown;
  readonly data?: unknown;
  readonly truncated?: boolean;
};

type ComponentToolErrorPayload = {
  readonly error: { readonly message: string };
};

const isToolErrorPayload = (v: unknown): v is ComponentToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  const e = r['error'] as Record<string, unknown>;
  return typeof e['message'] === 'string';
};

const isComponentSuccess = (v: unknown): v is ComponentSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['stableId'] === 'string' && typeof r['displayName'] === 'string';
};

export const vueGetStateHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { stable_id: args.stable_id };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.include_props !== undefined) wirePayload['include_props'] = args.include_props;
  if (args.include_state !== undefined) wirePayload['include_state'] = args.include_state;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'vue_get_state',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: VUE_GET_STATE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`vue_get_state failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the vue_get_state handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`vue_get_state nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`vue_get_state: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler (NOT a transport error). Most common: stable_id not resolvable — re-call vue_tree to refresh ids; the Vue tree may have re-rendered into a different shape.',
    ]);
  }

  if (!isComponentSuccess(response.payload)) {
    return errorResponse(
      'vue_get_state returned a malformed payload (missing stableId/displayName).',
      [
        'The page-world handler did not match the VueComponentInfo shape. Check packages/extension/src/vue/serialize_component.ts.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...response.payload,
  };

  const nextSteps: string[] = [
    'Component info shape: { stableId, displayName, key?, props?, setupState?, data?, truncated? }. setupState is the <script setup>/setup() binding object (refs auto-unwrapped); data is options-API reactive data. Values are serialized with a 16KB cap.',
  ];
  if (response.payload.truncated === true) {
    nextSteps.push(
      'truncated:true — one or more of props/setupState/data exceeded the 16KB serializer cap. Re-call with include_props:false or include_state:false to isolate the bloated field, or use evaluate() to read a narrower projection.',
    );
  }
  if (args.include_state === false) {
    nextSteps.push(
      'include_state:false suppressed setupState + data; pass include_state:true (default) to retrieve them.',
    );
  }

  return okResponse(data, nextSteps);
};

export const vueGetStateTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'vue_get_state',
  description:
    "Return the props, setup() bindings, and options-API data of a single Vue 3 component identified by stable_id (obtained from a prior vue_tree call). Args: { extension_id?, tab_id?, stable_id: required non-empty string, include_props?: bool=true, include_state?: bool=true }. Returns { extensionId, tabId, stableId, displayName, key?, props?, setupState?, data?, truncated? }. setupState holds <script setup>/setup() bindings (refs auto-unwrapped); data holds options-API reactive state. Empty surfaces are omitted. Tool-level error when stable_id no longer resolves — re-call vue_tree to refresh ids. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: vueGetStateHandler,
});
