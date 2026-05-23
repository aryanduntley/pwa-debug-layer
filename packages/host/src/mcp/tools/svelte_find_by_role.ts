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

const SVELTE_FIND_BY_ROLE_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  role: z.string().min(1),
  name: z.string().min(1).optional(),
  max_matches: z.number().int().positive().max(500).optional(),
};

type FindMatch = {
  readonly stableId: string;
  readonly file: string;
  readonly role: string;
  readonly name?: string;
};

type FindSuccessPayload = {
  readonly matches: ReadonlyArray<FindMatch>;
  readonly truncated: boolean;
};

type FindToolErrorPayload = { readonly error: { readonly message: string } };

const isToolErrorPayload = (v: unknown): v is FindToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  return typeof (r['error'] as Record<string, unknown>)['message'] === 'string';
};

const isFindSuccess = (v: unknown): v is FindSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r['matches']) && typeof r['truncated'] === 'boolean';
};

export const svelteFindByRoleMcpHandler = async (
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
    tool: 'svelte_find_by_role',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SVELTE_FIND_BY_ROLE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`svelte_find_by_role failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected and the svelte_find_by_role handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`svelte_find_by_role nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout, or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`svelte_find_by_role: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler. Most common: an invalid name regex (compiled with new RegExp, no flags).',
    ]);
  }

  if (!isFindSuccess(response.payload)) {
    return errorResponse(
      'svelte_find_by_role returned a malformed payload (missing matches/truncated).',
      ['Check packages/extension/src/svelte/find_by_role.ts.'],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    matches: response.payload.matches,
    truncated: response.payload.truncated,
  };

  const nextSteps: string[] = [
    'matches[] contains { stableId, file, role, name? }, de-duped to one entry per owning component .svelte file. Roles use the shared simplified ARIA mapping (button, link, heading, region, textbox, …). Svelte has no instance/state read.',
  ];
  if (response.payload.matches.length === 0) {
    nextSteps.push(
      'No matches. Either no element had that role (exact, lowercase ARIA names; drop the name filter), OR this is a production build with no __svelte_meta — call svelte_components to check dev:true.',
    );
  }
  if (response.payload.truncated) {
    nextSteps.push(
      'truncated:true — max_matches (default 20) reached. Raise it or tighten role / name.',
    );
  }

  return okResponse(data, nextSteps);
};

export const svelteFindByRoleTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'svelte_find_by_role',
  description:
    "Find Svelte components whose rendered DOM node has a given ARIA role, optionally narrowed by an accessible-name regex. Args: { extension_id?, tab_id?, role: ARIA role string (exact, lowercase; explicit role attr or simplified implicit mapping), name?: regex source for the accessible name (new RegExp, no flags), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { stableId, file, role, name? }[], truncated }. Matches map to the owning component .svelte file (stableId === file), de-duped per file. DEV-mode only (relies on __svelte_meta). No state read exists for Svelte. Runs in page-world via the page-bridge. CALL host_status FIRST.",
  inputSchema,
  handler: svelteFindByRoleMcpHandler,
});
