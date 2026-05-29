import { z } from 'zod';
import {
  okResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { listRecordings, readRecording } from '../../popup_recording/reader.js';

const inputSchema = {
  label: z.string().min(1).optional(),
  mode: z.enum(['flat', 'primary', 'tree']).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
};

export const popupReplayHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  _ctx: ToolContext,
): Promise<ToolResponse> => {
  if (args.label === undefined) {
    const recordings = await listRecordings();
    return okResponse({ recordings }, [
      recordings.length === 0
        ? 'No popup recordings on disk yet. Capture one with popup_record action=\'start\' ... action=\'stop\'.'
        : `Available recordings (label, count, startedAt/stoppedAt). Read one with popup_replay { label, mode:'primary'|'tree'|'flat' }.`,
    ]);
  }

  const mode = args.mode ?? 'primary';
  const result = await readRecording(
    args.label,
    mode,
    {
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    },
  );

  if (result.mode === 'tree') {
    return okResponse({ ...result }, [
      `Hierarchical view of recording '${args.label}': ${result.roots.length} primary popup(s) (total ${result.total} events). Each node has popupId, role, library, detection, host, phases[], and nested children (linked by parentPopupId). Use mode='flat' for the raw event sequence or mode='primary' for primary events only.`,
    ]);
  }
  return okResponse({ label: args.label, ...result }, [
    `Recording '${args.label}' (${result.mode}): ${result.entries.length} of ${result.total} event(s) from offset ${result.offset}. ${result.hasMore ? 'hasMore=true — page with offset+limit.' : 'End of recording.'} mode='tree' gives the popup hierarchy; mode='flat' the full raw sequence (primary+nested).`,
  ]);
};

export const popupReplayTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'popup_replay',
  description:
    "Read back a popup recording captured by popup_record. With no label, lists available recordings on disk ({label, count, startedAt, stoppedAt}). With a label, projects the recorded library_popup events three ways via `mode`: 'primary' (default — only role!=='nested' events, one stream per logical widget; paginated by offset/limit), 'flat' (the raw full-fidelity sequence including nested components; paginated), or 'tree' (a hierarchy of popup nodes — primary roots with nested children attached by parentPopupId, each node summarizing popupId/role/library/detection/host/phases). Reads from <config>/pwa-debug/popup-recordings/<label>/events.jsonl. Use it to review a recorded debugging episode sequentially or hierarchically. Read-only.",
  inputSchema,
  handler: popupReplayHandler,
});
