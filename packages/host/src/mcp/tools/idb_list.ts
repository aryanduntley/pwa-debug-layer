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
import type { IdbListResult } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const IDB_LIST_IPC_TIMEOUT_MS = 8000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
};

const readResult = (raw: unknown): IdbListResult | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['supported'] !== 'boolean') return null;
  if (!Array.isArray(r['databases'])) return null;
  return raw as IdbListResult;
};

export const idbListHandler = async (
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
    tool: 'idb_list',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: IDB_LIST_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`idb_list failed: ${(err as Error).message}`, [
      'IPC request did not complete. Opening many databases can take a moment — check the extension service worker console and confirm the SW is connected.',
    ]);
  }
  if (response.error) {
    return errorResponse(`idb_list nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('idb_list returned a malformed payload.', [
      'The page-world handler returned a shape that does not match IdbListResult. Check packages/extension/src/storage/idb_read.ts.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'IdbListResult: { supported, databases: [{ name, version, stores: [{ name, keyPath, autoIncrement, indexes }], error? }] }. Pass a db + store name to idb_query to read a slice of records.',
  ];
  if (!result.supported) {
    nextSteps.push('supported:false — indexedDB is unavailable here (insecure context / unsupported browser).');
  } else if (result.databases.length === 0) {
    nextSteps.push('No IndexedDB databases. The app stores nothing in IndexedDB (it may use web storage instead — try storage_get).');
  }

  return okResponse(data, nextSteps);
};

export const idbListTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'idb_list',
  description:
    "List the debugged PWA's IndexedDB databases and their schema. Returns IdbListResult { supported, databases: [{ name, version, stores: [{ name, keyPath, autoIncrement, indexes: [{ name, keyPath, unique, multiEntry }] }], error? }] } read from the page's indexedDB API. Use to discover where the app keeps structured/offline data, then idb_query(db, store) to read records — the recurring 'inspect IndexedDB live' need that CDP/chrome-devtools-mcp does not surface for your real profile. Read-only: opening a database never creates one. Args: { extension_id?, tab_id? }. Page-world read. CALL host_status FIRST.",
  inputSchema,
  handler: idbListHandler,
});
