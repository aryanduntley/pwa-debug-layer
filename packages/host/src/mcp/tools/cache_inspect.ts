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
import type { CacheInspectResult } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const CACHE_INSPECT_IPC_TIMEOUT_MS = 8000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  cache_name: z.string().min(1),
  limit: z.number().int().positive().max(1000).optional(),
};

const readResult = (raw: unknown): CacheInspectResult | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['supported'] !== 'boolean') return null;
  if (typeof r['found'] !== 'boolean') return null;
  if (!Array.isArray(r['entries'])) return null;
  if (typeof r['entryCount'] !== 'number') return null;
  if (typeof r['truncated'] !== 'boolean') return null;
  return raw as CacheInspectResult;
};

export const cacheInspectHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { cache_name: args.cache_name };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.limit !== undefined) wirePayload['limit'] = args.limit;

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: 'cache_inspect',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: CACHE_INSPECT_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`cache_inspect failed: ${(err as Error).message}`, [
      'IPC request did not complete. A very large cache can take a while to enumerate — retry with a smaller limit, or check the SW console.',
    ]);
  }
  if (response.error) {
    return errorResponse(`cache_inspect nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA and confirm the cache name (from cache_list).',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('cache_inspect returned a malformed payload.', [
      'The page-world handler returned a shape that does not match CacheInspectResult. Check packages/extension/src/cache_storage/read.ts.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'CacheInspectResult.entries[]: { url, method, status, contentType, contentLength, dateHeader, ageSeconds, cacheControl }. ageSeconds = how long ago the response was generated (from its Date header) — high values on app shell / API responses are the stale-cache smell.',
  ];
  if (!result.supported) {
    nextSteps.push('supported:false — caches.* is unavailable here.');
  } else if (!result.found) {
    nextSteps.push(`No cache named "${args.cache_name}". Call cache_list to see the exact names.`);
  } else if (result.truncated) {
    nextSteps.push(
      `Showing ${result.entries.length} of ${result.entryCount} entries (capped by limit). Re-call with a higher limit to see more.`,
    );
  }

  return okResponse(data, nextSteps);
};

export const cacheInspectTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'cache_inspect',
  description:
    "Inspect one CacheStorage cache's entries. Returns CacheInspectResult { supported, found, name, entries: [{ url, method, status, contentType, contentLength, dateHeader, ageSeconds, cacheControl }], entryCount, truncated }. ageSeconds (now − the response's Date header) is the staleness signal — old app-shell HTML or API responses are the usual 'why won't my update show' / 'why is my data stale' cause. Get the cache name from cache_list first. Bodies are NOT read (size is from content-length). Args: { extension_id?, tab_id?, cache_name (required), limit?: default 200, max 1000 }. Page-world read; CDP cannot do this. CALL host_status FIRST.",
  inputSchema,
  handler: cacheInspectHandler,
});
