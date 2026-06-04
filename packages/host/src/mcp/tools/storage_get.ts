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
import type { StorageGetResult } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const STORAGE_GET_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  area: z.enum(['local', 'session']).optional(),
  limit: z.number().int().positive().max(2000).optional(),
};

const readResult = (raw: unknown): StorageGetResult | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['supported'] !== 'boolean') return null;
  if (r['area'] !== 'local' && r['area'] !== 'session') return null;
  if (!Array.isArray(r['entries'])) return null;
  if (typeof r['entryCount'] !== 'number') return null;
  if (typeof r['truncated'] !== 'boolean') return null;
  return raw as StorageGetResult;
};

export const storageGetHandler = async (
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
  if (args.area !== undefined) wirePayload['area'] = args.area;
  if (args.limit !== undefined) wirePayload['limit'] = args.limit;

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: 'storage_get',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: STORAGE_GET_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`storage_get failed: ${(err as Error).message}`, [
      'IPC request did not complete. Check the extension service worker console and confirm the SW is connected.',
    ]);
  }
  if (response.error) {
    return errorResponse(`storage_get nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('storage_get returned a malformed payload.', [
      'The page-world handler returned a shape that does not match StorageGetResult. Check packages/extension/src/storage/web_storage.ts.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'StorageGetResult: { supported, area, entries: [{ key, value, truncated? }], entryCount, truncated }. Long values are capped (truncated:true). For IndexedDB use idb_list / idb_query instead — web storage holds only string key/value pairs.',
  ];
  if (!result.supported) {
    nextSteps.push(`supported:false — ${result.area}Storage is unavailable here (disabled / blocked context).`);
  } else if (result.entries.length === 0) {
    nextSteps.push(`No keys in ${result.area}Storage. Try area:'${result.area === 'local' ? 'session' : 'local'}', or the app stores its state in IndexedDB (idb_list).`);
  } else if (result.truncated) {
    nextSteps.push(`Showing ${result.entries.length} of ${result.entryCount} keys (capped by limit). Re-call with a higher limit to see more.`);
  }

  return okResponse(data, nextSteps);
};

export const storageGetTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'storage_get',
  description:
    "Snapshot the debugged PWA's web storage. Returns StorageGetResult { supported, area, entries: [{ key, value, truncated? }], entryCount, truncated } read from the page's localStorage or sessionStorage. Use to inspect auth tokens, feature flags, cached app state, and 'why is the app in this state' bugs that live in storage. Reads your REAL profile's storage; CDP/chrome-devtools-mcp does not surface this. Values over 8KB are truncated. For structured/large data the app keeps in IndexedDB, use idb_list + idb_query instead. Args: { extension_id?, tab_id?, area?: 'local' (default) | 'session', limit?: default 500, max 2000 }. Page-world read. CALL host_status FIRST.",
  inputSchema,
  handler: storageGetHandler,
});
