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

const SOLID_FIND_BY_TEXT_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  pattern: z.string().min(1),
  exact: z.boolean().optional(),
  max_matches: z.number().int().positive().max(500).optional(),
};

type Match = { readonly locator: string; readonly tag: string; readonly matchedText: string };
type SuccessPayload = { readonly matches: ReadonlyArray<Match>; readonly truncated: boolean };
type ToolErrorPayload = { readonly error: { readonly message: string } };

const isToolErrorPayload = (v: unknown): v is ToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  return typeof (r['error'] as Record<string, unknown>)['message'] === 'string';
};

const isSuccess = (v: unknown): v is SuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r['matches']) && typeof r['truncated'] === 'boolean';
};

export const solidFindByTextMcpHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { pattern: args.pattern };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.exact !== undefined) wirePayload['exact'] = args.exact;
  if (args.max_matches !== undefined) wirePayload['max_matches'] = args.max_matches;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'solid_find_by_text',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SOLID_FIND_BY_TEXT_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`solid_find_by_text failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the solid_find_by_text handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`solid_find_by_text nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`solid_find_by_text: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler. Most common: an invalid regex pattern (new RegExp, no flags).',
    ]);
  }

  if (!isSuccess(response.payload)) {
    return errorResponse(
      'solid_find_by_text returned a malformed payload (missing matches/truncated).',
      ['Check packages/extension/src/solid/find_by_text.ts.'],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    matches: response.payload.matches,
    truncated: response.payload.truncated,
  };

  const nextSteps: string[] = [
    'matches[] contains { locator, tag, matchedText } at the ELEMENT level — Solid exposes no component identity, so these are DOM nodes, not components. `locator` is a best-effort CSS-ish selector (tag#id / tag.class:nth-of-type(n)).',
  ];
  if (response.payload.matches.length === 0) {
    nextSteps.push(
      'No matches. Pattern is new RegExp (no flags, case-sensitive); keep exact:false for substring. Confirm the page is a Solid app with solid_detect.',
    );
  }
  if (response.payload.truncated) {
    nextSteps.push('truncated:true — max_matches (default 20) reached. Raise it or tighten the pattern.');
  }

  return okResponse(data, nextSteps);
};

export const solidFindByTextTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'solid_find_by_text',
  description:
    "Find DOM ELEMENTS whose rendered text matches a regex on a Solid page. Args: { extension_id?, tab_id?, pattern: regex source (new RegExp, no flags, case-sensitive), exact?: bool=false, max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { locator, tag, matchedText }[], truncated }. NOTE: Solid has no component identity, so matches are ELEMENTS (locator = best-effort CSS-ish selector), NOT components — this is the documented Solid degradation. Runs in page-world via the page-bridge. CALL host_status FIRST.",
  inputSchema,
  handler: solidFindByTextMcpHandler,
});
