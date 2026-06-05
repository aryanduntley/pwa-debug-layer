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
import type { IdbQueryResult } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const IDB_QUERY_IPC_TIMEOUT_MS = 8000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  db: z.string().min(1),
  store: z.string().min(1),
  limit: z.number().int().positive().max(1000).optional(),
};

const readResult = (raw: unknown): IdbQueryResult | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['supported'] !== 'boolean') return null;
  if (typeof r['found'] !== 'boolean') return null;
  if (!Array.isArray(r['records'])) return null;
  if (typeof r['returned'] !== 'number') return null;
  if (typeof r['truncated'] !== 'boolean') return null;
  return raw as IdbQueryResult;
};

export const idbQueryHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called and the user has reloaded the extension.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { db: args.db, store: args.store };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.limit !== undefined) wirePayload['limit'] = args.limit;

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: 'idb_query',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: IDB_QUERY_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`idb_query failed: ${(err as Error).message}`, [
      'IPC request did not complete. A large store can take a while to read — retry with a smaller limit, or check the SW console.',
    ]);
  }
  if (response.error) {
    return errorResponse(`idb_query nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA and confirm the db + store names (from idb_list).',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('idb_query returned a malformed payload.', [
      'The page-world handler returned a shape that does not match IdbQueryResult. Check packages/extension/src/storage/idb_read.ts.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'IdbQueryResult: { supported, found, db, store, records: [{ key, value, truncated? }], returned, truncated }. Records are read read-only; large values are capped (truncated:true).',
  ];
  if (!result.supported) {
    nextSteps.push('supported:false — indexedDB is unavailable here.');
  } else if (!result.found) {
    nextSteps.push(`No "${args.store}" store in db "${args.db}". Call idb_list to see the exact db + store names.`);
  } else if (result.error !== undefined) {
    nextSteps.push(`The store exists but the read failed: ${result.error}`);
  } else if (result.truncated) {
    nextSteps.push(
      `Showing ${result.returned} records (capped by limit). Re-call with a higher limit to see more.`,
    );
  }

  return okResponse(data, nextSteps);
};

export const idbQueryTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'idb_query',
  description:
    "Read a capped slice of records from one IndexedDB object store. Returns IdbQueryResult { supported, found, db, store, records: [{ key, value, truncated? }], returned, truncated } read read-only from the page's indexedDB. Get the db + store names from idb_list first. Use to inspect the app's offline/cached structured data — the 'what's actually in IndexedDB' need CDP/chrome-devtools-mcp does not surface for your real profile. Read-only (no writes); values over 16KB are truncated. Args: { extension_id?, tab_id?, db (required), store (required), limit?: default 100, max 1000 }. Page-world read. CALL host_status FIRST.",
  inputSchema,
  handler: idbQueryHandler,
});
