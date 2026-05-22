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
  path: z.string().min(1).optional(),
  framework: z.string().min(1).optional(),
};

type StoreSuccessPayload = {
  readonly framework: string;
  readonly state: unknown;
  readonly path?: string;
  readonly truncated?: boolean;
  readonly scopeUrl: string;
};

const isStoreSuccess = (v: unknown): v is StoreSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return 'state' in r && typeof r['scopeUrl'] === 'string';
};

export const storeGetStateHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const result = await requestStoreTool(ctx, {
    toolName: 'store_get_state',
    wireTool: 'store_get_state',
    ...(args.extension_id !== undefined ? { extensionId: args.extension_id } : {}),
    ...(args.tab_id !== undefined ? { tabId: args.tab_id } : {}),
    ...(args.framework !== undefined ? { framework: args.framework } : {}),
    payload: args.path !== undefined ? { path: args.path } : {},
  });
  if (!result.ok) return result.response;

  if (!isStoreSuccess(result.payload)) {
    return errorResponse(
      'store_get_state returned a malformed payload (missing state/scopeUrl).',
      [
        'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts store_get_state branch.',
      ],
    );
  }

  const data = {
    extensionId: result.extensionId,
    tabId: result.tabId,
    ...result.payload,
  };

  const nextSteps: string[] = [
    'Store value shape: { extensionId, tabId, framework, state, path?, truncated?, scopeUrl }. framework names the detected store library (e.g. "redux"). state is the live snapshot, optionally pruned to the path argument. Pass framework to force a specific adapter; omit it to auto-detect.',
  ];
  if (result.payload.truncated === true) {
    nextSteps.push(
      'truncated:true — the returned value exceeded the 16KB serializer cap and was replaced with a {__type:"Truncated", approxSize, max} placeholder. Re-call with a narrower path argument (e.g. counter.value) to retrieve a smaller slice.',
    );
  }

  return okResponse(data, nextSteps);
};

export const storeGetStateTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'store_get_state',
  description:
    "Return the current state of the active tab's JS store, optionally pruned to a dotted/bracket path. Auto-detects the store framework (Redux today; Zustand/Pinia/Jotai as adapters land), or pass framework to force one. Args: { extension_id?, tab_id?, path?: 'counter.value' | 'todos[0].text', framework?: 'redux' }. Returns { extensionId, tabId, framework, state, path?, truncated?, scopeUrl }. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: storeGetStateHandler,
});
