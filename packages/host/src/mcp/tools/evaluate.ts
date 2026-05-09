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

const EVALUATE_IPC_TIMEOUT_MS = 5000;
const EVALUATE_MAX_EXPRESSION_TIMEOUT_MS = 3500;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  expression: z.string().min(1),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(EVALUATE_MAX_EXPRESSION_TIMEOUT_MS)
    .optional(),
  await_promise: z.boolean().optional(),
};

type EvaluatePayload = {
  readonly value?: unknown;
  readonly truncated?: boolean;
  readonly durationMs?: number;
  readonly error?: { readonly message: string; readonly stack?: string };
};

const readEvaluatePayload = (raw: unknown): EvaluatePayload => {
  if (raw === null || typeof raw !== 'object') return Object.freeze({});
  const r = raw as Record<string, unknown>;
  const out: {
    value?: unknown;
    truncated?: boolean;
    durationMs?: number;
    error?: { readonly message: string; readonly stack?: string };
  } = {};
  if ('value' in r) out.value = r['value'];
  if (typeof r['truncated'] === 'boolean') out.truncated = r['truncated'];
  if (typeof r['durationMs'] === 'number') out.durationMs = r['durationMs'];
  const err = r['error'];
  if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e['message'] === 'string') {
      out.error =
        typeof e['stack'] === 'string'
          ? Object.freeze({ message: e['message'], stack: e['stack'] })
          : Object.freeze({ message: e['message'] });
    }
  }
  return Object.freeze(out);
};

const isPromiseTag = (v: unknown): boolean =>
  v !== null &&
  typeof v === 'object' &&
  (v as Record<string, unknown>)['__type'] === 'Promise';

export const evaluateHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions so Chrome respawns the NMH.',
    ]);
  }

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'evaluate',
    extensionId: target.extensionId,
    payload: {
      expression: args.expression,
      ...(args.tab_id !== undefined ? { tab_id: args.tab_id } : {}),
      ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
      ...(args.await_promise !== undefined
        ? { await_promise: args.await_promise }
        : {}),
    },
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: EVALUATE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`evaluate failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console and confirm the SW is connected to the host. If the SW responder is missing the evaluate handler, the request will time out.',
    ]);
  }

  if (response.error) {
    return errorResponse(`evaluate nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab (open an http(s) tab), explicit tab_id not found, page-bridge timeout (page-world script not attached on chrome:// pages or the chrome web store), or page-world handler threw before producing an EvaluateOutput. Inspect the SW console for [pwa-debug] errors.',
    ]);
  }

  const payload = readEvaluatePayload(response.payload);
  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...payload,
  };

  const nextSteps: string[] = [
    "Expression evaluated in MAIN world via the page-bridge (no CDP — coexists with the user's open DevTools). Result is serialized through captures/serialize.ts: 16KB cap, cycle-safe; DOM nodes/functions/promises/errors get { __type: ... } tags.",
  ];
  if (payload.error !== undefined) {
    nextSteps.push(
      'evaluate.error is populated — the expression compiled but threw, rejected, or timed out. error.stack (when present) is the page-world stack from the moment of failure. Distinct from the outer error envelope: outer error = transport failure; payload.error = expression failure.',
    );
  }
  if (payload.truncated === true) {
    nextSteps.push(
      'truncated:true — the result exceeded 16KB and was replaced with a Truncated tag. Re-evaluate with a smaller projection (e.g., select specific fields, slice arrays, JSON.stringify with a replacer).',
    );
  }
  if (args.await_promise !== true && isPromiseTag(payload.value)) {
    nextSteps.push(
      `value is { __type: 'Promise' } because await_promise was not set. Pass await_promise:true to await resolution (max timeout_ms = ${EVALUATE_MAX_EXPRESSION_TIMEOUT_MS}ms; default 3000ms).`,
    );
  }

  return okResponse(data, nextSteps);
};

export const evaluateTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'evaluate',
  description:
    "Evaluate a JavaScript expression in the page (MAIN world) via the page-bridge — NO CDP, so this coexists with the user's open DevTools (chrome-devtools-mcp's evaluate_script cannot). Sees framework globals (window.React, __REACT_DEVTOOLS_GLOBAL_HOOK__, store hooks, etc.) that the SW and content script cannot reach. Args: { extension_id?, tab_id?, expression: non-empty string, timeout_ms?: <=3500ms (default 3000), await_promise? }. Returns { extensionId, tabId, value?, truncated?, durationMs, error? } where value is serialized with a 16KB cap (DOM nodes/functions/promises/errors become { __type: ... } tags; cycles become { __type: 'Cycle' }). When await_promise=true and the expression returns a thenable, races resolution against timeout_ms. error{message,stack?} is populated for syntax errors, sync throws, async rejects, and timeouts — the call still returns ok:true so AI can introspect failure detail. Expression mode only (single expression, no statements; same as DevTools console expression eval). With no extension_id/tab_id, targets the single connected NMH and the active tab. CALL host_status FIRST to see which extensions are connected.",
  inputSchema,
  handler: evaluateHandler,
});
