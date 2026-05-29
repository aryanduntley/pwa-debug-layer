import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { resolveTarget } from './target_resolution.js';
import {
  recordingStatus,
  sanitizeLabel,
  startRecording,
  stopRecording,
} from '../../popup_recording/recorder.js';

const inputSchema = {
  action: z.enum(['start', 'stop', 'status']),
  label: z.string().min(1).optional(),
  extension_id: z.string().min(1).optional(),
};

export const popupRecordHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. A recording is bound to one extension.',
    ]);
  }

  if (args.action === 'status') {
    return okResponse({ recording: recordingStatus(target.extensionId) }, [
      'Recording status for this extension. start a recording, perform the actions you want to capture, then stop and view with popup_replay.',
    ]);
  }

  if (args.action === 'start') {
    // getOrCreate so the subscription is in place even before the first event.
    const captures = ctx.capturesRegistry.getOrCreate(target.extensionId);
    const label = sanitizeLabel(args.label ?? `rec-${Date.now()}`);
    const status = startRecording(captures, target.extensionId, label, Date.now());
    return okResponse({ recording: status }, [
      `Recording '${status.label}' is live for extension ${target.extensionId}. It buffers EVERY library_popup event (primary + nested, in order) until you stop it. Perform the popup interactions you want to capture, then call popup_record action='stop'. Already-active recording? This returns the in-progress one (one per extension).`,
    ]);
  }

  // action === 'stop'
  const result = await stopRecording(target.extensionId, Date.now());
  if (result === undefined) {
    return okResponse({ recording: { active: false } }, [
      'No active recording for this extension. Start one with popup_record action=\'start\' before stopping.',
    ]);
  }
  return okResponse({ recording: result }, [
    `Saved ${result.count} popup event(s) to ${result.path}. View it with popup_replay { label: '${result.label}', mode: 'primary' | 'tree' | 'flat' } — primary = one entry per widget, tree = hierarchy via parentPopupId, flat = raw sequence.`,
  ]);
};

export const popupRecordTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'popup_record',
  description:
    "Bounded, intent-driven recording of the library_popup event stream for a target extension. action='start' subscribes to the extension's capture intake and buffers EVERY library_popup event (primary + nested, in arrival order) in memory — immune to ring-buffer eviction — until action='stop', which persists the stream to <config>/pwa-debug/popup-recordings/<label>/events.jsonl (+ meta.json) and returns { path, count }. action='status' reports the active recording { active, label, startedAt, count }. Forward-only: only events between start and stop are recorded — start with intent, perform the interactions, stop, then view with popup_replay. One recording per extension (start while active returns the in-progress one). Optional label (defaults to rec-<timestamp>); optional extension_id (defaults to the single connected NMH). Use this to capture a specific debugging episode for sequential review instead of always-on noise.",
  inputSchema,
  handler: popupRecordHandler,
});
