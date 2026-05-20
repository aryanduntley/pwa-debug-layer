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

const SOURCE_MAP_RESOLVE_IPC_TIMEOUT_MS = 8000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  script_url: z.string().min(1),
  line: z.number().int().min(1),
  column: z.number().int().min(0),
};

type ResolvedFrame = {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly name?: string;
};

type SuccessPayload = {
  readonly original?: ResolvedFrame;
  readonly scopeUrl: string;
};

type ToolErrorPayload = {
  readonly error: { readonly message: string };
};

const isToolErrorPayload = (v: unknown): v is ToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  const e = r['error'] as Record<string, unknown>;
  return typeof e['message'] === 'string';
};

const isSuccess = (v: unknown): v is SuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['scopeUrl'] === 'string';
};

export const sourceMapResolveHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const enabled = ctx.settingsStore.getSetting('capture.sourceMap.enabled');
  if (enabled !== true) {
    return errorResponse(
      'source_map_resolve is disabled (capture.sourceMap.enabled=false).',
      [
        "Enable via settings.set { key: 'capture.sourceMap.enabled', value: true } and retry. Default is true; the setting exists so users can opt out of the script + map fetch overhead in privacy-sensitive sessions.",
      ],
    );
  }

  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called.',
    ]);
  }

  const wirePayload: Record<string, unknown> = {
    script_url: args.script_url,
    line: args.line,
    column: args.column,
  };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'source_map_resolve',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SOURCE_MAP_RESOLVE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`source_map_resolve failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Script + map fetch can take longer than other tools; the 8s timeout reflects that.',
    ]);
  }

  if (response.error) {
    return errorResponse(`source_map_resolve nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`source_map_resolve: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler. Common causes: script fetch failed (CORS or 4xx/5xx); malformed input.',
    ]);
  }

  if (!isSuccess(response.payload)) {
    return errorResponse(
      'source_map_resolve returned a malformed payload (missing scopeUrl).',
      [
        'The page-world handler did not match the expected shape. Check packages/extension/src/page_bridge/page_dispatch.ts sourceMapResolveHandler.',
      ],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...response.payload,
  };

  const nextSteps: string[] = [];
  if (response.payload.original !== undefined) {
    const f = response.payload.original;
    nextSteps.push(
      `Resolved to ${f.source}:${f.line}:${f.column}${f.name !== undefined ? ` (${f.name})` : ''}.`,
    );
  } else {
    nextSteps.push(
      'No mapping returned. Either the script has no sourceMappingURL comment, the .map URL was unreachable, or the (line, column) fell outside the map\'s segments. Call console_tail to see what raw frames look like; they typically include script_url, line, column you can pass back here.',
    );
  }

  return okResponse(data, nextSteps);
};

export const sourceMapResolveTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'source_map_resolve',
  description:
    "Resolve a single generated stack frame (script_url + line + column) to its original-source location using the script's source map. Args: { extension_id?, tab_id?, script_url: non-empty string, line: int >= 1, column: int >= 0 }. Returns { extensionId, tabId, original?: { source, line, column, name? }, scopeUrl }. original is undefined when no map is available or no mapping exists at the requested coordinates. Disabled via capture.sourceMap.enabled=false. M13 ships query-time resolution; M13.5 will add capture-time auto-annotation when needed.",
  inputSchema,
  handler: sourceMapResolveHandler,
});
