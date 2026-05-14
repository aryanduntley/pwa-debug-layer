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

const REACT_GET_STATE_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  stable_id: z.string().min(1),
  root_index: z.number().int().nonnegative().optional(),
  include_props: z.boolean().optional(),
  include_hooks: z.boolean().optional(),
};

type ComponentSuccessPayload = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly props?: unknown;
  readonly state?: unknown;
  readonly hooks?: ReadonlyArray<unknown>;
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

export const reactGetStateHandler = async (
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
  if (args.root_index !== undefined) wirePayload['root_index'] = args.root_index;
  if (args.include_props !== undefined) wirePayload['include_props'] = args.include_props;
  if (args.include_hooks !== undefined) wirePayload['include_hooks'] = args.include_hooks;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'react_get_state',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: REACT_GET_STATE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`react_get_state failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the react_get_state handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`react_get_state nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(
      `react_get_state: ${response.payload.error.message}`,
      [
        'Tool-level error from the page-world handler (NOT a transport error). Most common: stable_id not resolvable — re-call react.tree to refresh ids; the React tree may have re-rendered into a different shape.',
      ],
    );
  }

  if (!isComponentSuccess(response.payload)) {
    return errorResponse(
      'react_get_state returned a malformed payload (missing stableId/displayName).',
      [
        'The page-world handler did not match the ReactComponentInfo shape. Check packages/extension/src/react/serialize_component.ts.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...response.payload,
  };

  const nextSteps: string[] = [
    'Component info shape: { stableId, displayName, key?, props?, state?, hooks?: SerializedHook[], truncated? }. SerializedHook entries are typed as "state"|"memo"|"effect"|"ref"|"custom" (state and reducer are conflated; memo covers useMemo and useCallback). Values are serialized with a 16KB cap.',
  ];
  if (response.payload.truncated === true) {
    nextSteps.push(
      'truncated:true — one or more of props/state/hooks exceeded the 16KB serializer cap. Re-call with include_props:false or include_hooks:false to isolate the bloated field, or use evaluate() to read a narrower projection of the offending field.',
    );
  }
  if (args.include_hooks === false && response.payload.hooks === undefined) {
    nextSteps.push(
      'include_hooks:false suppressed the hooks field; pass include_hooks:true (default) to retrieve them.',
    );
  }

  return okResponse(data, nextSteps);
};

export const reactGetStateTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'react_get_state',
  description:
    "Return the props, state, and hooks of a single React component identified by stable_id (obtained from a prior react_tree call). Args: { extension_id?, tab_id?, stable_id: required non-empty string, root_index?: number=0 (must match the root used to compute the id), include_props?: bool=true, include_hooks?: bool=true }. Returns { extensionId, tabId, stableId, displayName, key?, props?, state?, hooks?: SerializedHook[], truncated? }. SerializedHook entries: { type: 'state'|'memo'|'effect'|'ref'|'custom'; index; value?; deps?; truncated? }. Tool-level error when stable_id no longer resolves — in that case re-call react_tree to refresh ids. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: reactGetStateHandler,
});
