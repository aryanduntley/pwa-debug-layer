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

const SESSION_RECORD_IPC_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  tab_id: z.number().int().optional(),
  action: z.enum(['start', 'stop']),
  session_id: z.string().min(1).optional(),
  duration_cap_ms: z.number().int().positive().optional(),
};

type RecordSuccessPayload = {
  readonly active: boolean;
  readonly sessionId?: string;
  readonly durationCapMs?: number;
  readonly scopeUrl: string;
};

type RecordToolErrorPayload = {
  readonly error: { readonly message: string };
};

const isToolErrorPayload = (v: unknown): v is RecordToolErrorPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['error'] === null || typeof r['error'] !== 'object') return false;
  const e = r['error'] as Record<string, unknown>;
  return typeof e['message'] === 'string';
};

const isRecordSuccess = (v: unknown): v is RecordSuccessPayload => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['active'] === 'boolean' && typeof r['scopeUrl'] === 'string';
};

export const sessionRecordHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called.',
    ]);
  }

  const wirePayload: Record<string, unknown> = { action: args.action };
  if (args.tab_id !== undefined) wirePayload['tab_id'] = args.tab_id;
  if (args.session_id !== undefined) wirePayload['session_id'] = args.session_id;
  if (args.duration_cap_ms !== undefined)
    wirePayload['duration_cap_ms'] = args.duration_cap_ms;

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'session_record',
    extensionId: target.extensionId,
    payload: wirePayload,
  });

  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SESSION_RECORD_IPC_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`session_record failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect).',
    ]);
  }

  if (response.error) {
    return errorResponse(`session_record nmh error: ${response.error.message}`, [
      'NMH-mode rejected the request. Common causes: no active tab, page-bridge timeout.',
    ]);
  }

  if (isToolErrorPayload(response.payload)) {
    return errorResponse(`session_record: ${response.payload.error.message}`, [
      'Tool-level error from the page-world handler.',
    ]);
  }

  if (!isRecordSuccess(response.payload)) {
    return errorResponse(
      'session_record returned a malformed payload (missing active/scopeUrl).',
      ['The page-world handler did not match the expected shape.'],
    );
  }

  const data = {
    extensionId: target.extensionId,
    tabId: args.tab_id ?? null,
    ...response.payload,
  };

  const nextSteps: string[] = [];
  if (response.payload.active) {
    nextSteps.push(
      'Recording active. rrweb events accumulate in the host store_change ... actually the "replay" ring buffer; call session_replay to read them with cursor pagination. Re-call session_record(start) to replace the recording with a new sessionId; call session_record(stop) to tear it down.',
    );
    if (response.payload.durationCapMs !== undefined) {
      nextSteps.push(
        `durationCapMs=${response.payload.durationCapMs} — recording will auto-stop after this many ms.`,
      );
    }
  } else {
    nextSteps.push(
      'Recording inactive. Either action="stop" was called or no recording was ever started.',
    );
  }

  return okResponse(data, nextSteps);
};

export const sessionRecordTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'session_record',
  description:
    "Start or stop a rrweb session recording on the active tab. Each recorded event flows through the capture pipeline as a 'replay' CaptureKind and accumulates in the host replay ring buffer (readable via session_replay). Args: { extension_id?, tab_id?, action: 'start' | 'stop', session_id?: stable id for grouping (auto-generated when missing), duration_cap_ms?: int > 0 (auto-stop deadline) }. Single recording per page-world; action='start' replaces any prior recording. CALL host_status FIRST to see connections.",
  inputSchema,
  handler: sessionRecordHandler,
});
