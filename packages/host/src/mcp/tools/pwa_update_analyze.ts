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
import type { UpdateGatherResult, NetworkFailure } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';
import { analyzeUpdateSkew } from '../../update_analysis/analyze.js';
import type { HostStoredEvent } from '../../captures_in/captures_in.js';

const UPDATE_ANALYZE_IPC_TIMEOUT_MS = 8000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  per_cache_limit: z.number().int().positive().max(1000).optional(),
  skew_threshold_seconds: z.number().int().nonnegative().optional(),
};

const readGather = (raw: unknown): UpdateGatherResult | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sw = r['sw'];
  if (sw === null || typeof sw !== 'object') return null;
  if (typeof (sw as Record<string, unknown>)['supported'] !== 'boolean') return null;
  if (!Array.isArray(r['cacheEntries'])) return null;
  return raw as UpdateGatherResult;
};

/**
 * Extract recent network failures (status ≥ 400) from the host's `network` ring
 * buffer, deduped by URL (latest status wins). The analyzer narrows these to
 * JS/CSS chunk misses.
 */
const networkFailures = (events: readonly HostStoredEvent[]): NetworkFailure[] => {
  const byUrl = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'fetch' && e.kind !== 'xhr') continue;
    const url = e['url'];
    const status = e['status'];
    if (typeof url !== 'string' || typeof status !== 'number' || status < 400) continue;
    byUrl.set(url, status);
  }
  return [...byUrl.entries()].map(([url, status]) => ({ url, status }));
};

export const pwaUpdateAnalyzeHandler = async (
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
  if (args.per_cache_limit !== undefined) wirePayload['per_cache_limit'] = args.per_cache_limit;

  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId: randomUUID(),
    tool: 'pwa_update_gather',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: UPDATE_ANALYZE_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`pwa_update_analyze failed: ${(err as Error).message}`, [
      'IPC request did not complete. Gathering many caches can take a moment — check the extension service worker console and confirm the SW is connected.',
    ]);
  }
  if (response.error) {
    return errorResponse(`pwa_update_analyze nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA (chrome:// / web-store pages cannot be read).',
    ]);
  }

  const gathered = readGather(response.payload);
  if (gathered === null) {
    return errorResponse('pwa_update_analyze returned a malformed gather payload.', [
      'The page-world gather returned a shape that does not match UpdateGatherResult. Check packages/extension/src/update_analysis/gather.ts.',
    ]);
  }

  // Pull recent network failures from this extension's network ring buffer.
  // Absent (no captures-flavor events yet) → analyze with SW + cache only.
  const captures = ctx.capturesRegistry.get(target.extensionId);
  const failures = captures === undefined ? [] : networkFailures(captures.tail('network'));

  const result = analyzeUpdateSkew(gathered.sw, gathered.cacheEntries, failures, {
    ...(args.skew_threshold_seconds !== undefined
      ? { skewThresholdSeconds: args.skew_threshold_seconds }
      : {}),
  });

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const nextSteps: string[] = [
    'UpdateAnalysisResult: { supported, hasWaitingUpdate, controller, findings: [{ code, severity, message }], cachedHtml, cachedJs, chunk404s, summary }. Codes: waiting_update_active_client, html_older_js, chunk_404.',
  ];
  if (!result.supported) {
    nextSteps.push('supported:false — service workers are unavailable in this context.');
  } else if (result.findings.length === 0) {
    nextSteps.push('No issues detected. If users still report stale code, confirm the page was loaded fresh (the network buffer only holds requests seen since the extension attached) and re-run after reproducing.');
  } else {
    if (result.findings.some((f) => f.code === 'waiting_update_active_client')) {
      nextSteps.push('A waiting SW is blocked behind open clients — close all tabs for the scope or add skipWaiting()+clients.claim() to activate. sw_status shows the worker states.');
    }
    if (result.findings.some((f) => f.code === 'html_older_js')) {
      nextSteps.push('Version skew: use cache_inspect on the navigation/HTML cache to confirm ageSeconds, and prefer a network-first strategy for HTML so it cannot outlive the JS it references.');
    }
    if (result.findings.some((f) => f.code === 'chunk_404')) {
      nextSteps.push('Live chunk 404s observed — network_tail (filter status>=400) lists them in full.');
    }
  }

  return okResponse(data, nextSteps);
};

export const pwaUpdateAnalyzeTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'pwa_update_analyze',
  description:
    "Diagnose service-worker update propagation + version skew for the debugged PWA. Composes sw_status (waiting worker + controller), CacheStorage entry ages (cached HTML vs JS), and recent network 404s into UpdateAnalysisResult { supported, hasWaitingUpdate, controller, findings: [{ code, severity, message }], cachedHtml, cachedJs, chunk404s, summary }. Detects: waiting_update_active_client (an installed SW is waiting while this client stays on the old worker — 'my update won't show'), html_older_js (stale cached HTML referencing chunk hashes the newer JS dropped), and chunk_404 (live chunk misses corroborating the skew). Use for 'why are some users on old code' / 'why are chunks 404ing after deploy'. Analysis over existing reads; no new capture. Args: { extension_id?, tab_id?, per_cache_limit?: default 100, skew_threshold_seconds?: default 3600 }. CALL host_status FIRST.",
  inputSchema,
  handler: pwaUpdateAnalyzeHandler,
});
