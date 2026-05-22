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
  action: z.enum(['start', 'stop']),
  path: z.string().min(1).optional(),
};

type SubscribeSuccessPayload = {
  readonly active: boolean;
  readonly framework?: string;
  readonly path?: string;
  readonly scopeUrl: string;
};

const isSubscribeSuccess = (v: unknown): v is SubscribeSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['active'] === 'boolean' && typeof r['scopeUrl'] === 'string';
};

export const storeSubscribeHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const wirePayload: Record<string, unknown> = { action: args.action };
  if (args.path !== undefined) wirePayload['path'] = args.path;

  const result = await requestStoreTool(ctx, {
    toolName: 'store_subscribe',
    wireTool: 'store_subscribe',
    ...(args.extension_id !== undefined ? { extensionId: args.extension_id } : {}),
    ...(args.tab_id !== undefined ? { tabId: args.tab_id } : {}),
    ...(args.framework !== undefined ? { framework: args.framework } : {}),
    payload: wirePayload,
  });
  if (!result.ok) return result.response;

  if (!isSubscribeSuccess(result.payload)) {
    return errorResponse(
      'store_subscribe returned a malformed payload (missing active/scopeUrl).',
      [
        'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts store_subscribe branch.',
      ],
    );
  }

  const data = {
    extensionId: result.extensionId,
    tabId: result.tabId,
    ...result.payload,
  };

  const nextSteps: string[] = [];
  if (result.payload.active) {
    nextSteps.push(
      'Subscription active (framework field names the detected store). Call store_tail to read accumulated store_change events. Re-call store_subscribe with action="start" + a new path to swap the subscription (idempotent re-config). Call action="stop" to tear it down.',
    );
  } else {
    nextSteps.push(
      'Subscription inactive. action="start" was not called or the most recent call was "stop".',
    );
  }

  return okResponse(data, nextSteps);
};

export const storeSubscribeTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'store_subscribe',
  description:
    "Start or stop a store subscription on the active tab. While active, each store change whose path-narrowed snapshot differs from the prior snapshot emits a store_change event (tagged with the detecting framework) that flows through the standard capture pipeline; read accumulated events via store_tail. Auto-detects the framework or pass framework to force one. Args: { extension_id?, tab_id?, framework?, action: 'start' | 'stop', path?: 'counter' | 'todos.items' }. Returns { extensionId, tabId, active, framework?, path?, scopeUrl }. Single subscription per page-world; calling action='start' again replaces any prior subscription. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: storeSubscribeHandler,
});
