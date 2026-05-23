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

const SOLID_FIND_BY_ROLE_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  role: z.string().min(1),
  name: z.string().min(1).optional(),
  max_matches: z.number().int().positive().max(500).optional(),
};

type Match = {
  readonly locator: string;
  readonly tag: string;
  readonly role: string;
  readonly name?: string;
};
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

export const solidFindByRoleMcpHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { role: args.role };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.name !== undefined) wirePayload['name'] = args.name;
  if (args.max_matches !== undefined) wirePayload['max_matches'] = args.max_matches;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'solid_find_by_role',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SOLID_FIND_BY_ROLE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`solid_find_by_role failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the solid_find_by_role handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`solid_find_by_role nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`solid_find_by_role: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler. Most common: an invalid name regex (new RegExp, no flags).',
    ]);
  }

  if (!isSuccess(response.payload)) {
    return errorResponse(
      'solid_find_by_role returned a malformed payload (missing matches/truncated).',
      ['Check packages/extension/src/solid/find_by_role.ts.'],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    matches: response.payload.matches,
    truncated: response.payload.truncated,
  };

  const nextSteps: string[] = [
    'matches[] contains { locator, tag, role, name? } at the ELEMENT level — Solid exposes no component identity, so these are DOM nodes, not components (documented Solid degradation). Roles use the shared simplified ARIA mapping.',
  ];
  if (response.payload.matches.length === 0) {
    nextSteps.push(
      'No matches. Roles are exact, lowercase ARIA names; drop the name filter to broaden. Confirm the page is a Solid app with solid_detect.',
    );
  }
  if (response.payload.truncated) {
    nextSteps.push('truncated:true — max_matches (default 20) reached. Raise it or tighten role / name.');
  }

  return okResponse(data, nextSteps);
};

export const solidFindByRoleTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'solid_find_by_role',
  description:
    "Find DOM ELEMENTS with a given ARIA role on a Solid page, optionally narrowed by an accessible-name regex. Args: { extension_id?, tab_id?, role: ARIA role string (exact, lowercase), name?: regex source (new RegExp, no flags), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { locator, tag, role, name? }[], truncated }. NOTE: Solid has no component identity, so matches are ELEMENTS (locator = best-effort CSS-ish selector), NOT components — documented Solid degradation. Runs in page-world via the page-bridge. CALL host_status FIRST.",
  inputSchema,
  handler: solidFindByRoleMcpHandler,
});
