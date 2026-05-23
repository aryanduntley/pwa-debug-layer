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

const SOLID_DETECT_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
};

type SolidDetectPayload = {
  readonly present: boolean;
  readonly devtoolsHook: boolean;
  readonly hydration: boolean;
  readonly delegatedEventCount: number;
  readonly scopeUrl: string;
};

const readPayload = (raw: unknown): SolidDetectPayload | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r['present'] !== 'boolean' ||
    typeof r['devtoolsHook'] !== 'boolean' ||
    typeof r['hydration'] !== 'boolean' ||
    typeof r['delegatedEventCount'] !== 'number'
  ) {
    return null;
  }
  return r as unknown as SolidDetectPayload;
};

export const solidDetectMcpHandler = async (
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

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'solid_detect',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SOLID_DETECT_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`solid_detect failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the solid_detect handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`solid_detect nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab or page-bridge timeout.',
    ]);
  }

  const payload = readPayload(response.payload);
  if (payload === null) {
    return errorResponse('solid_detect returned a malformed payload.', [
      'The page-world handler did not match the expected shape. Check packages/extension/src/solid/detect.ts.',
    ]);
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    present: payload.present,
    devtoolsHook: payload.devtoolsHook,
    hydration: payload.hydration,
    delegatedEventCount: payload.delegatedEventCount,
  };

  const nextSteps: string[] = [
    'Solid exposes NO persisted component tree and NO DOM->component pointer, so there is no solid_components / solid_get_state. Use solid_find_by_text / solid_find_by_role to locate DOM ELEMENTS (returned as locator + tag) on a Solid page — matches cannot be attributed to components without the @solid-devtools plugin.',
  ];
  if (!payload.present) {
    nextSteps.push('present:false — no Solid signals detected. Verify the page runs Solid.');
  } else if (!payload.devtoolsHook) {
    nextSteps.push(
      'devtoolsHook:false — @solid-devtools is not installed on the page. Deep component/signal introspection is unavailable; only DOM-level find works. To get more, the app must add the solid-devtools plugin + import.',
    );
  } else {
    nextSteps.push(
      'devtoolsHook:true — @solid-devtools IS present. Its tree/signal data could be surfaced by a future bridge; today only detection + DOM-level find are wired.',
    );
  }

  return okResponse(data, nextSteps);
};

export const solidDetectTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'solid_detect',
  description:
    "Detect SolidJS on the active (or specified) tab. Args: { extension_id?, tab_id? }. Returns { extensionId, tabId, present, devtoolsHook, hydration, delegatedEventCount }. Solid has no virtual DOM and no persisted component tree, so unlike React/Vue there is NO solid_components or solid_get_state — detection is best-effort (the @solid-devtools hook window.__SOLID_DEVTOOLS__, the _$HY hydration global, and a heuristic count of elements carrying Solid's $$-delegated-event props). devtoolsHook:true means @solid-devtools is installed (deeper data may be reachable). Use solid_find_by_text / solid_find_by_role for DOM-level element matching. Runs in page-world via the page-bridge. CALL host_status FIRST.",
  inputSchema,
  handler: solidDetectMcpHandler,
});
