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
import type { CacheMatchResult } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const CACHE_MATCH_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  url: z.string().min(1),
};

const readResult = (raw: unknown): CacheMatchResult | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['supported'] !== 'boolean') return null;
  if (typeof r['matched'] !== 'boolean') return null;
  if (typeof r['url'] !== 'string') return null;
  return raw as CacheMatchResult;
};

export const cacheMatchHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { url: args.url };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: 'cache_match',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: CACHE_MATCH_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`cache_match failed: ${(err as Error).message}`, [
      'IPC request did not complete. Check the extension service worker console and confirm the SW is connected.',
    ]);
  }
  if (response.error) {
    return errorResponse(`cache_match nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA.',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('cache_match returned a malformed payload.', [
      'The page-world handler returned a shape that does not match CacheMatchResult. Check packages/extension/src/cache_storage/read.ts.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'CacheMatchResult: { supported, url, matched, cacheName, entry }. When matched, cacheName is the cache that would serve this URL and entry.ageSeconds is how stale that cached response is. Note: this is what CacheStorage would return — the actual fetch strategy (cache-first vs network-first vs stale-while-revalidate) lives in the service worker\'s fetch handler and is not directly observable; treat a hit as "a cached copy exists", not "this is definitely served".',
  ];
  if (!result.supported) {
    nextSteps.push('supported:false — caches.* is unavailable here.');
  } else if (!result.matched) {
    nextSteps.push('No cache serves this URL — it would go to the network (or fail offline). Check the exact URL (query string + trailing slash matter for cache keys).');
  }

  return okResponse(data, nextSteps);
};

export const cacheMatchTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'cache_match',
  description:
    "Find which CacheStorage cache would serve a URL. Returns CacheMatchResult { supported, url, matched, cacheName, entry } — iterates the caches in order and reports the first hit plus the matched entry (status, content-type, ageSeconds, cache-control). Answers 'is /app.js cached, by which cache, and how old is it'. CAVEAT: a hit means a cached copy EXISTS; the SW's fetch handler decides whether it's actually served (cache-first / network-first / SWR) and that strategy is not observable from here — reported as a heuristic, not a guarantee. Args: { extension_id?, tab_id?, url (required) }. Page-world read. CALL host_status FIRST.",
  inputSchema,
  handler: cacheMatchHandler,
});
