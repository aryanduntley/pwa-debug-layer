import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { resolveTarget } from './target_resolution.js';
import { tailWithFilterMerged } from '../../captures_query/captures_query.js';
import { encodeCursor, type PopupEntry } from '@pwa-debug/shared';
import {
  FILTER_SPEC_HINT,
  filterSchema,
  tailErrorToResponse,
  toFilterSpec,
} from './_filter_helpers.js';
import type { FilterSpec } from '@pwa-debug/shared';

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  include_nested: z.boolean().optional(),
  filter: filterSchema,
};

// Regex (matched against each entry's JSON) that drops NESTED popup events —
// the component-level web components inside a widget (e.g. Reown <wui-*>/<ph-*>
// inside <w3m-modal>). Top-level button roles serialize as "role":"button", so
// this only matches the event's own role field. Injected unless include_nested.
const NESTED_EXCLUDE_PATTERN = '"role":"nested"';

const withNestedExcluded = (
  spec: FilterSpec | undefined,
): FilterSpec => {
  const pattern = spec?.pattern ?? {};
  return {
    ...(spec ?? {}),
    pattern: {
      ...pattern,
      exclude: [...(pattern.exclude ?? []), NESTED_EXCLUDE_PATTERN],
    },
  };
};

export const popupTailHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension.',
      FILTER_SPEC_HINT,
    ]);
  }

  const captures = ctx.capturesRegistry.get(target.extensionId);
  if (captures === undefined) {
    return okResponse(
      { entries: [], cursor: null, hasMore: false },
      [
        `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. The CapturesIn instance is created lazily on first event — trigger a library popup/widget to open in a tab (e.g. a wallet-connect modal) and retry.`,
        FILTER_SPEC_HINT,
      ],
    );
  }

  const sessionId = captures.getStats().sessionId;
  const popupBuffer = captures.buffer('library_popup');
  const baseSpec = toFilterSpec(args.filter);
  // Default view = PRIMARY popups only (one entry per logical widget). Pass
  // include_nested=true to also surface the nested component events.
  const filterSpec =
    args.include_nested === true ? baseSpec : withNestedExcluded(baseSpec);
  const result = await tailWithFilterMerged({
    buffer: popupBuffer,
    spec: filterSpec,
    ctx: { currentSessionId: sessionId },
    kind: 'library_popup',
  });

  if (!result.ok) {
    return tailErrorToResponse(result.error);
  }

  const entries: PopupEntry[] = result.entries.map(
    (e): PopupEntry =>
      ({
        ...e,
        cursor: encodeCursor({
          sessionId: e.sessionId,
          sequenceNumber: e.sequenceNumber,
        }),
      }) as unknown as PopupEntry,
  );

  const scope = args.include_nested === true ? 'primary + nested' : 'primary-only';
  const nextSteps: string[] = [
    `Returned ${entries.length} PopupEntry record(s) for extension ${target.extensionId} (host session ${sessionId}); scope=${scope}. Each entry carries page-world fields (ts, frameUrl, frameKey, popupId, phase=appeared|updated|disappeared, detection=shadow|portal, library tag with 'unknown' fallback, host{tagName, id?, classes?, selector}, role=primary|nested, parentPopupId) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber, cursor). By DEFAULT only role='primary' popups are returned — one entry per logical widget, so a component-heavy modal (e.g. Reown/WalletConnect, ~50 nested web components) shows as a single popup. Pass include_nested=true to also see the nested component events (each carries parentPopupId pointing at its enclosing popup, for reconstructing the widget tree). On appeared/updated, state{visible, title?, text?, buttons?[{label,role}], content?, truncated?} snapshots the widget content. popupId is stable across a popup's appeared→updated→disappeared lifecycle.`,
  ];
  if (result.hasMore) {
    nextSteps.push(
      `hasMore=true: more matching events exist beyond limit. Page forward by passing the response top-level cursor as filter.since on your next call.`,
    );
  } else if (result.cursor === null) {
    nextSteps.push(
      "No library_popup events match the current filter; cursor is null. If you set filter.level, note it does not apply to popup events (none have a level field) — drop it. Otherwise interact with the page to open a popup, or adjust filter.pattern.",
    );
  } else {
    nextSteps.push(
      'Latest tail returned (hasMore=false). To poll for new events as they arrive, retry with filter.since=cursor (top-level field of this response).',
    );
  }
  nextSteps.push(FILTER_SPEC_HINT);

  return okResponse(
    { entries, cursor: result.cursor, hasMore: result.hasMore },
    nextSteps,
  );
};

export const popupTailTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'popup_tail',
  description:
    "Tail the host-side library_popup ring buffer (injected library widgets/popups: WalletConnect, RainbowKit, ConnectKit, Privy, and generic shadow/portal overlays) for a target extension with cursor pagination + FilterSpec. Returns { entries: PopupEntry[]; cursor: Cursor|null; hasMore: bool }. Each PopupEntry carries page-world fields (ts, frameUrl, frameKey, popupId, phase=appeared|updated|disappeared, detection=shadow|portal, library tag ('unknown' when no signature matched), host{tagName, id?, classes?, selector}, role=primary|nested, parentPopupId, and on appeared/updated a state snapshot {visible, title?, text?, buttons?[{label,role}], content?, truncated?} of the widget content) plus host fields (receivedAt, sessionId, extensionId, sequenceNumber) and a per-entry cursor. By DEFAULT only PRIMARY popups are returned — one entry per logical widget — so a component-heavy modal (e.g. a Reown/WalletConnect modal built from ~50 nested shadow-DOM web components) surfaces as a SINGLE popup instead of dozens. Pass include_nested=true to also return the nested component events; each nested entry's parentPopupId points at its enclosing popup so you can reconstruct the widget tree. popupId is stable across a popup's appeared→updated→disappeared lifecycle. With no extension_id, targets the single connected NMH (errors if zero or multiple). FilterSpec (all optional): pattern={include?: regex sources[], exclude?: regex sources[]} matches JSON.stringify of each entry (use it to filter by library, e.g. include:['walletconnect']); since/until=opaque cursor strings; limit=int 1..1000 (default 200); level is ignored (popup events have no console-level field). Errors carry kind in next_steps for AI self-correction.",
  inputSchema,
  handler: popupTailHandler,
});
