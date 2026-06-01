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
import type { InstallabilityResult, InstallabilityGap } from '@pwa-debug/shared';
import { resolveTarget } from './target_resolution.js';

const PWA_INSTALLABILITY_IPC_TIMEOUT_MS = 8000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
};

const readResult = (raw: unknown): InstallabilityResult | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['supported'] !== 'boolean') return null;
  if (typeof r['installable'] !== 'boolean') return null;
  if (typeof r['manifestFound'] !== 'boolean') return null;
  if (!Array.isArray(r['gaps'])) return null;
  return raw as InstallabilityResult;
};

export const pwaInstallabilityHandler = async (
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
    tool: 'pwa_installability',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: PWA_INSTALLABILITY_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`pwa_installability failed: ${(err as Error).message}`, [
      'IPC request did not complete (the manifest fetch may have hung). Check the SW console and confirm the SW is connected.',
    ]);
  }
  if (response.error) {
    return errorResponse(`pwa_installability nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Open an http(s) tab to the PWA.',
    ]);
  }

  const result = readResult(response.payload);
  if (result === null) {
    return errorResponse('pwa_installability returned a malformed payload.', [
      'The page-world handler returned a shape that does not match InstallabilityResult. Check packages/extension/src/pwa_installability/.',
    ]);
  }

  const data = { extensionId: target.extensionId, tabId: args.tab_id ?? null, ...result };
  const errors = result.gaps.filter((g: InstallabilityGap) => g.severity === 'error');
  const warnings = result.gaps.filter((g: InstallabilityGap) => g.severity === 'warning');

  const nextSteps: string[] = [
    `installable=${result.installable}. InstallabilityResult: { installable, manifestUrl, manifestFound, secureContext, hasServiceWorker, manifest, gaps: [{ code, severity, message, fix }] }. severity 'error' blocks install; 'warning' is recommended.`,
  ];
  if (errors.length > 0) {
    nextSteps.push(
      `BLOCKERS (${errors.length}): ${errors.map((g) => `[${g.code}] ${g.message} FIX: ${g.fix}`).join(' | ')}`,
    );
  }
  if (warnings.length > 0) {
    nextSteps.push(
      `Recommended (${warnings.length}): ${warnings.map((g) => `[${g.code}] ${g.fix}`).join(' | ')}`,
    );
  }
  if (result.installable && result.gaps.length === 0) {
    nextSteps.push('No gaps — the PWA meets the core installability criteria checked here.');
  }

  return okResponse(data, nextSteps);
};

export const pwaInstallabilityTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'pwa_installability',
  description:
    "Diagnose whether the debugged PWA is installable, with actionable gaps instead of 'manifest invalid'. Fetches + parses the web app manifest and checks: manifest present/valid, name/short_name, start_url, app display mode, icons (192 AND 512 AND a maskable purpose), secure context (HTTPS/localhost), and a registered service worker. Returns InstallabilityResult { installable, manifestUrl, manifestFound, secureContext, hasServiceWorker, manifest, gaps: [{ code, severity('error' blocks / 'warning' recommended), message, fix }] }. Each gap names exactly what's wrong and how to fix it. Reads your real page. Args: { extension_id?, tab_id? }. Page-world read. CALL host_status FIRST.",
  inputSchema,
  handler: pwaInstallabilityHandler,
});
