import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ACTION_TOOL_SPECS, type ActionToolSpec, type ActionParamDef } from '@pwa-debug/shared';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import type { IpcRequestEnvelope } from '../ipc/envelope.js';
import { resolveTarget } from './target_resolution.js';

const ACTION_IPC_TIMEOUT_MS = 5000;

// Locator + routing fields shared by every action tool.
const locatorSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  framework: z.enum(['react', 'vue', 'svelte', 'solid', 'dom']).optional(),
  selector: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  exact: z.boolean().optional(),
  stable_id: z.string().min(1).optional(),
  nth: z.number().int().nonnegative().optional(),
  require_unique: z.boolean().optional(),
};

// Locator + routing wire keys forwarded to the page-world; tab_id is forwarded
// so the SW can target a specific tab. Per-tool param keys are appended from the
// spec in makeActionHandler.
const LOCATOR_WIRE_KEYS = [
  'framework', 'selector', 'role', 'name', 'text', 'exact', 'stable_id',
  'nth', 'require_unique', 'tab_id',
] as const;

/** Map a typed param def to its Zod schema (optional unless required). */
const zodForParam = (p: ActionParamDef): z.ZodTypeAny => {
  const base =
    p.type === 'number'
      ? z.number()
      : p.type === 'boolean'
        ? z.boolean()
        : p.type === 'enum'
          ? z.enum([...(p.enum ?? [])] as [string, ...string[]])
          : z.string();
  return p.required ? base : base.optional();
};

const LOCATOR_DOC =
  "Locator: pass ONE of { selector } | { role, name? } | { text, exact? } | { framework, stable_id }. " +
  "framework: react|vue|svelte|solid|dom (only meaningful for stable_id; svelte stable_id is a file, not an element — use role/text/selector). " +
  "Disambiguate multiple matches with nth (0-based) or require_unique. Also extension_id?/tab_id?. CALL host_status FIRST.";

/** Build the Zod inputSchema (ZodRawShape) for one action tool from its spec. */
export const buildActionInputSchema = (spec: ActionToolSpec): z.ZodRawShape => {
  const shape: Record<string, z.ZodTypeAny> = { ...locatorSchema };
  for (const p of spec.params) shape[p.key] = zodForParam(p);
  return shape;
};

const isToolErrorPayload = (v: unknown): v is { error: { message: string } } => {
  if (v === null || typeof v !== 'object') return false;
  const e = (v as Record<string, unknown>)['error'];
  return e !== null && typeof e === 'object' && typeof (e as Record<string, unknown>)['message'] === 'string';
};

/** Build the generic MCP handler for one action tool. */
export const makeActionHandler =
  (spec: ActionToolSpec) =>
  async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResponse> => {
    const target = resolveTarget(ctx, args['extension_id'] as string | undefined);
    if (!target.ok) {
      return errorResponse(target.error, [
        'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the extension reloaded.',
      ]);
    }

    const payload: Record<string, unknown> = {};
    const wireKeys = [...LOCATOR_WIRE_KEYS, ...spec.params.map((p) => p.key)];
    for (const k of wireKeys) if (args[k] !== undefined) payload[k] = args[k];

    const env: IpcRequestEnvelope = Object.freeze({
      type: 'request',
      requestId: randomUUID(),
      tool: spec.tool,
      extensionId: target.extensionId,
      payload,
    });

    let response;
    try {
      response = await ctx.ipcServer.request(target.extensionId, env, {
        timeoutMs: ACTION_IPC_TIMEOUT_MS,
      });
    } catch (err) {
      return errorResponse(`${spec.tool} failed: ${(err as Error).message}`, [
        `IPC request did not complete. Confirm the SW is connected and the ${spec.tool} handler is wired in the SW.`,
      ]);
    }

    if (response.error) {
      return errorResponse(`${spec.tool} nmh error: ${response.error.message}`, [
        'NMH-mode rejected the request (no active tab, page-bridge timeout on a chrome:// page, or the page-world handler threw).',
      ]);
    }

    if (isToolErrorPayload(response.payload)) {
      return errorResponse(`${spec.tool}: ${response.payload.error.message}`, [
        'Locator did not resolve (not found / ambiguous) or a required param was missing. Refine the locator (add nth/require_unique) or check the value/label/key arg.',
      ]);
    }

    const data = { extensionId: target.extensionId, tabId: args['tab_id'] ?? null, ...(response.payload as object) };
    const nextSteps: string[] = [
      'located: { describedBy, matchCount } — the resolved target. action: an ActionResult { acted, defaultPrevented?, detail? }. If matchCount>1 the first match was used unless nth was given.',
    ];
    const acted = (response.payload as { action?: { acted?: unknown } }).action?.acted;
    if (acted === false) {
      nextSteps.push('action.acted=false — the element was found but the action could not be applied (wrong element type for this action). Check the target.');
    }
    return okResponse(data, nextSteps);
  };

export const interactionActionTools: readonly ToolDef[] = Object.freeze(
  ACTION_TOOL_SPECS.map((spec) => {
    const inputSchema = buildActionInputSchema(spec);
    return Object.freeze({
      name: spec.tool,
      description: `${spec.summary} ${LOCATOR_DOC} Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools.`,
      inputSchema,
      handler: makeActionHandler(spec),
    });
  }) as unknown as readonly ToolDef[],
);
