import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { requestStoreTool } from './_store_request.js';

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  framework: z.string().min(1).optional(),
  action: z.object({
    type: z.string().min(1),
    payload: z.unknown().optional(),
  }),
};

type DispatchSuccessPayload = {
  readonly dispatched: true;
  readonly framework: string;
  readonly action: { readonly type: string; readonly payload?: unknown };
  readonly scopeUrl: string;
};

const isDispatchSuccess = (v: unknown): v is DispatchSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r['dispatched'] === true && typeof r['scopeUrl'] === 'string';
};

export const storeDispatchHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  // Setting gate FIRST — never even build an IPC envelope if disabled.
  const allowed = ctx.settingsStore.getSetting('capture.stores.allowDispatch');
  if (allowed !== true) {
    return errorResponse(
      'store_dispatch is disabled (capture.stores.allowDispatch=false).',
      [
        "Enable writes via settings.set { key: 'capture.stores.allowDispatch', value: true } and retry. Default false because dispatching mutates user-visible application state; only opt in when intentionally driving the app from the AI side.",
      ],
    );
  }

  const result = await requestStoreTool(ctx, {
    toolName: 'store_dispatch',
    wireTool: 'store_dispatch',
    ...(args.extension_id !== undefined ? { extensionId: args.extension_id } : {}),
    ...(args.tab_id !== undefined ? { tabId: args.tab_id } : {}),
    ...(args.framework !== undefined ? { framework: args.framework } : {}),
    payload: { action: args.action },
  });
  if (!result.ok) return result.response;

  if (!isDispatchSuccess(result.payload)) {
    return errorResponse(
      'store_dispatch returned a malformed payload (missing dispatched/scopeUrl).',
      [
        'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts store_dispatch branch.',
      ],
    );
  }

  const data = {
    extensionId: result.extensionId,
    tabId: result.tabId,
    ...result.payload,
  };

  return okResponse(data, [
    'Action dispatched (framework field names the target store). Call store_get_state (optionally with a path) to verify the post-state, or store_tail to read the resulting store_change events if store_subscribe is active.',
  ]);
};

export const storeDispatchTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'store_dispatch',
  description:
    "Dispatch an action into the active tab's store (the only WRITE surface in the store-introspection family). DISABLED BY DEFAULT — opt in via settings.set { key: 'capture.stores.allowDispatch', value: true }. Auto-detects the framework or pass framework to force one. Args: { extension_id?, tab_id?, framework?, action: { type: non-empty string; payload? } }. Returns { extensionId, tabId, dispatched: true, framework, action, scopeUrl }. Note: stores without a Redux-style dispatch (e.g. some Zustand/Jotai setups) return a tool-level error from the page-world handler. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: storeDispatchHandler,
});
