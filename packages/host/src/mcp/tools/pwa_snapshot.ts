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
import type { RuntimeSnapshot } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const SNAPSHOT_IPC_TIMEOUT_MS = 10000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
};

const readResult = (raw: unknown): RuntimeSnapshot | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['url'] !== 'string') return null;
  if (typeof r['capturedAt'] !== 'number') return null;
  const sw = r['sw'];
  if (sw === null || typeof sw !== 'object') return null;
  const webStorage = r['webStorage'];
  if (webStorage === null || typeof webStorage !== 'object') return null;
  if (r['idb'] === null || typeof r['idb'] !== 'object') return null;
  if (r['cacheNames'] === null || typeof r['cacheNames'] !== 'object') return null;
  // `store` is RuntimeStoreState (object or null) — both are valid.
  return raw as RuntimeSnapshot;
};

export const pwaSnapshotHandler = async (
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
    tool: 'pwa_snapshot_gather',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SNAPSHOT_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`pwa_snapshot failed: ${(err as Error).message}`, [
      'IPC request did not complete. Composing the snapshot opens every IndexedDB database — a very large one can take a while; check the extension service worker console and confirm the SW is connected.',
    ]);
  }
  if (response.error) {
    return errorResponse(`pwa_snapshot nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('pwa_snapshot returned a malformed payload.', [
      'The page-world gather returned a shape that does not match RuntimeSnapshot. Check packages/extension/src/runtime_snapshot/gather.ts.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'RuntimeSnapshot: { url, title, capturedAt, sw, store, webStorage: { local, session }, idb (db/store schema), cacheNames }. One capped moment-in-time blob for repro — hand it off as deterministic bug context. For deeper detail drill in: idb_query (records), cache_inspect (entries), store_get_state (a state path).',
  ];
  if (result.store === null) {
    nextSteps.push('store:null — no Redux/Pinia/Jotai/Zustand store was auto-detected. If the app has one, expose it via a window.__pwaDebug_* handoff.');
  }
  if (!result.sw.supported) {
    nextSteps.push('sw.supported:false — service workers are unavailable in this context.');
  }

  return okResponse(data, nextSteps);
};

export const pwaSnapshotTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'pwa_snapshot',
  description:
    "Capture ONE capped runtime-state blob of the debugged PWA for deterministic bug-repro context. Returns RuntimeSnapshot { url, title, capturedAt, sw (service-worker status), store (auto-detected Redux/Pinia/Jotai/Zustand state, value-capped, or null), webStorage: { local, session }, idb (IndexedDB db/store schema — not records), cacheNames (CacheStorage names + counts) }. Composes the existing sw_status / store_get_state / storage_get / idb_list / cache_list reads into one moment-in-time record you can reason over or hand off to reproduce a bug. Read-only; no new capture surface. For deeper detail use idb_query / cache_inspect / store_get_state. Args: { extension_id?, tab_id? }. Page-world read. CALL host_status FIRST.",
  inputSchema,
  handler: pwaSnapshotHandler,
});
