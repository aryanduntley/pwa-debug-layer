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
import type { CacheListResult } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const CACHE_LIST_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
};

const readResult = (raw: unknown): CacheListResult | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['supported'] !== 'boolean') return null;
  if (!Array.isArray(r['caches'])) return null;
  return raw as CacheListResult;
};

export const cacheListHandler = async (
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

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: 'cache_list',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: CACHE_LIST_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`cache_list failed: ${(err as Error).message}`, [
      'IPC request did not complete. Check the extension service worker console and confirm the SW is connected.',
    ]);
  }
  if (response.error) {
    return errorResponse(`cache_list nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('cache_list returned a malformed payload.', [
      'The page-world handler returned a shape that does not match CacheListResult. Check packages/extension/src/cache_storage/read.ts.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'CacheListResult: { supported, caches: [{ name, entryCount }] }. Pass a cache name to cache_inspect to see its entries (url, age, content-type, size), or cache_match(url) to find which cache serves a given URL.',
  ];
  if (!result.supported) {
    nextSteps.push('supported:false — caches.* is unavailable here (insecure context / unsupported browser).');
  } else if (result.caches.length === 0) {
    nextSteps.push('No caches exist. The app has not populated CacheStorage (no service worker precache / runtime caching yet).');
  }

  return okResponse(data, nextSteps);
};

export const cacheListTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'cache_list',
  description:
    "List the debugged PWA's CacheStorage caches. Returns CacheListResult { supported, caches: [{ name, entryCount }] } read from the page's caches.* API. Use to see what the service worker has cached, then cache_inspect(cache_name) for per-entry detail (age/size/type) or cache_match(url) to find which cache serves a URL — the core of diagnosing stale-cache bugs. Reads your real profile's caches; CDP/chrome-devtools-mcp does not surface this. Args: { extension_id?, tab_id? }. Runs in page-world via the page-bridge. CALL host_status FIRST.",
  inputSchema,
  handler: cacheListHandler,
});
