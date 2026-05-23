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

const VUE_FIND_BY_TEXT_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  pattern: z.string().min(1),
  exact: z.boolean().optional(),
  root_index: z.number().int().nonnegative().optional(),
  max_matches: z.number().int().positive().max(500).optional(),
};

type FindByTextMatch = {
  readonly stableId: string;
  readonly displayName: string;
  readonly key?: string;
  readonly matchedText: string;
};

type FindByTextSuccessPayload = {
  readonly matches: ReadonlyArray<FindByTextMatch>;
  readonly truncated: boolean;
  readonly rootCount: number;
};

type FindByTextToolErrorPayload = {
  readonly error: { readonly message: string };
};

const isToolErrorPayload = (v: unknown): v is FindByTextToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  const e = r['error'] as Record<string, unknown>;
  return typeof e['message'] === 'string';
};

const isFindByTextSuccess = (v: unknown): v is FindByTextSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r['matches']) &&
    typeof r['truncated'] === 'boolean' &&
    typeof r['rootCount'] === 'number'
  );
};

export const vueFindByTextHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension at brave://extensions.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { pattern: args.pattern };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.exact !== undefined) wirePayload['exact'] = args.exact;
  if (args.root_index !== undefined) wirePayload['root_index'] = args.root_index;
  if (args.max_matches !== undefined) wirePayload['max_matches'] = args.max_matches;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'vue_find_by_text',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: VUE_FIND_BY_TEXT_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`vue_find_by_text failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Confirm the SW is connected to the host and the vue_find_by_text handler is wired in the SW.',
    ]);
  }

  if (response.error) {
    return errorResponse(`vue_find_by_text nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout (page-world not attached on chrome:// pages), or the page-world handler threw.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`vue_find_by_text: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler (NOT a transport error). Most common: an invalid regex pattern — the pattern is compiled with new RegExp (no flags); fix the source and retry.',
    ]);
  }

  if (!isFindByTextSuccess(response.payload)) {
    return errorResponse(
      'vue_find_by_text returned a malformed payload (missing matches/truncated/rootCount).',
      [
        'The page-world handler did not match the FindVueByTextResult shape. Check packages/extension/src/vue/find_by_text.ts.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    matches: response.payload.matches,
    truncated: response.payload.truncated,
    rootCount: response.payload.rootCount,
  };

  const nextSteps: string[] = [
    'matches[] contains { stableId, displayName, key?, matchedText }. Pass any stableId to vue_get_state for that component\'s props/setupState/data. matchedText is the matched substring (or the full trimmed text when exact:true). Matches are de-duped to one entry per owning component.',
  ];
  if (response.payload.matches.length === 0) {
    nextSteps.push(
      response.payload.rootCount === 0
        ? 'rootCount===0 — no Vue app roots detected. Verify the page mounts Vue 3 (a mount container carries __vue_app__) and app.mount() has run.'
        : 'No components matched. The pattern is a JS regex source compiled with new RegExp (no flags, case-sensitive). Broaden it, or keep exact:false (default) for substring matching.',
    );
  }
  if (
    args.root_index !== undefined &&
    args.root_index >= response.payload.rootCount
  ) {
    nextSteps.push(
      `root_index=${args.root_index} is out of range — only ${response.payload.rootCount} root(s) exist. Re-call without root_index to search all roots.`,
    );
  }
  if (response.payload.truncated) {
    nextSteps.push(
      'truncated:true — max_matches (default 20) was reached before the walk finished. Raise max_matches or tighten the pattern / root_index.',
    );
  }

  return okResponse(data, nextSteps);
};

export const vueFindByTextTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'vue_find_by_text',
  description:
    "Find Vue 3 components whose rendered DOM text matches a regex. Args: { extension_id?, tab_id?, pattern: required regex source string (compiled with new RegExp — no flags, case-sensitive), exact?: bool=false (true = regex must match the FULL trimmed text of a rendered element; false = substring match), root_index?: limit to one Vue root (default: all), max_matches?: cap (default 20, max 500) }. Returns { extensionId, tabId, matches: { stableId, displayName, key?, matchedText }[], truncated, rootCount }. Matching elements are mapped to their owning component (one entry per component). Feed any stableId into vue_get_state for that component's props/setupState/data. Tool-level error on an invalid regex pattern. Runs in page-world via the page-bridge — no CDP, coexists with the user's DevTools. CALL host_status FIRST to see which extensions are connected.",
  inputSchema,
  handler: vueFindByTextHandler,
});
