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

const SESSION_PING_TIMEOUT_MS = 5000;

const inputSchema = {
  extension_id: z.string().min(1).optional(),
};

export type PageWorldErrorCode =
  | 'cs_not_attached_refresh_tab'
  | 'page_blocks_scripts'
  | 'page_world_blocked'
  | 'restricted_url'
  | 'no_active_tab'
  | 'cs_inject_failed';

const PAGE_WORLD_ERROR_CODES: ReadonlySet<string> = new Set<PageWorldErrorCode>([
  'cs_not_attached_refresh_tab',
  'page_blocks_scripts',
  'page_world_blocked',
  'restricted_url',
  'no_active_tab',
  'cs_inject_failed',
]);

const NEXT_STEPS_BY_CODE: Readonly<Record<PageWorldErrorCode, readonly string[]>> = Object.freeze({
  cs_not_attached_refresh_tab: [
    "The page-world bridge is not responding even after the extension auto-injected its content scripts. The auto-recovery did not stick — the page may have rejected the injection silently or reloaded mid-flight.",
    "Ask the user to hard-refresh the page tab (Ctrl+Shift+R) and retry session_ping. If the problem repeats, ask them to reload the extension at chrome://extensions and then hard-refresh the page.",
  ],
  page_blocks_scripts: [
    "The site is blocking the pwa-debug content script. A content blocker is rejecting it.",
    "If the user is on Brave: ask them to click the lion icon in the address bar, set Shields to 'Down' for this site, refresh the page, and retry session_ping.",
    "If the user has uBlock Origin or a similar blocker: ask them to disable it for this site, refresh, and retry. If neither, the site's own CSP is blocking and pwa-debug cannot bypass it — inform the user this origin is unscriptable.",
  ],
  page_world_blocked: [
    "The content script attached but the MAIN-world page-world bridge cannot be reached. The site's Content-Security-Policy most likely blocks the inline script tag the bridge needs.",
    "Inform the user that this site's CSP prevents page-world introspection. pwa-debug cannot bypass site CSP. Console + network capture may still work via the content-script side, but live page-world reads (component state, store snapshots, evaluate) will not.",
  ],
  restricted_url: [
    "The current tab is on a URL that browsers do not allow extensions to touch (chrome://, the Web Store, about:, devtools://, file://, etc.).",
    "Ask the user to switch focus to a regular http(s) tab of the PWA they want to debug, then retry session_ping.",
  ],
  no_active_tab: [
    "No active http(s) tab is focused.",
    "Ask the user to focus a regular browser tab (not DevTools, not the extension popup) and retry session_ping.",
  ],
  cs_inject_failed: [
    "The auto-recovery injection (chrome.scripting.executeScript) itself failed. The extension cannot reach this tab.",
    "Ask the user to reload the extension at chrome://extensions and hard-refresh the page tab (Ctrl+Shift+R), then retry session_ping. If the problem persists, the tab may be on a URL the browser blocks all extensions from — ask the user what URL is in the address bar.",
  ],
});

const isPageWorldErrorCode = (v: unknown): v is PageWorldErrorCode =>
  typeof v === 'string' && PAGE_WORLD_ERROR_CODES.has(v);

const readPayloadString = (payload: unknown, key: string): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
};

const readPayloadNumber = (payload: unknown, key: string): number | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : null;
};

const readPayloadBoolean = (payload: unknown, key: string): boolean => {
  if (payload === null || typeof payload !== 'object') return false;
  const v = (payload as Record<string, unknown>)[key];
  return v === true;
};

const readPageWorldErrorCode = (
  payload: unknown,
): PageWorldErrorCode | null => {
  const raw = readPayloadString(payload, 'pageWorldError');
  return raw !== null && isPageWorldErrorCode(raw) ? raw : null;
};

type PageWorldSnapshot = {
  readonly url: string;
  readonly title: string;
  readonly readyState: 'loading' | 'interactive' | 'complete';
};

const readPageWorld = (payload: unknown): PageWorldSnapshot | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)['pageWorld'];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  const url = obj['url'];
  const title = obj['title'];
  const readyState = obj['readyState'];
  if (typeof url !== 'string') return null;
  if (typeof title !== 'string') return null;
  if (
    readyState !== 'loading' &&
    readyState !== 'interactive' &&
    readyState !== 'complete'
  ) {
    return null;
  }
  return Object.freeze({ url, title, readyState });
};

const buildNextSteps = (
  pageWorld: PageWorldSnapshot | null,
  pageWorldError: PageWorldErrorCode | null,
  selfHealed: boolean,
): string[] => {
  const steps: string[] = [
    'Round-trip MCP→IPC→NMH→SW→CS→page-world completed. extensionVersion and attachedTabId reflect the SW response; pageWorld carries url/title/readyState read from the active tab. If pageWorld is null and pageWorldError is set, the SW round-trip succeeded but the page-bridge half failed — see the next hint.',
  ];
  if (selfHealed && pageWorld !== null) {
    steps.push(
      'pageWorldSelfHealed:true — the content script was missing on the active tab (loaded before the extension reload) and the SW auto-injected it via chrome.scripting.executeScript. No user action needed; just informational.',
    );
  }
  if (pageWorldError !== null) {
    for (const hint of NEXT_STEPS_BY_CODE[pageWorldError]) steps.push(hint);
  } else if (pageWorld === null) {
    steps.push(
      'pageWorld is null but no typed pageWorldError was returned. This is unexpected — inspect the SW console for [pwa-debug] errors. The SW response payload may be malformed.',
    );
  }
  return steps;
};

export const sessionPingHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension at chrome://extensions so Chrome respawns the NMH.',
    ]);
  }

  const requestId = randomUUID();
  const env: IpcRequestEnvelope = Object.freeze({
    type: 'request',
    requestId,
    tool: 'session_ping',
    extensionId: target.extensionId,
    payload: {},
  });

  const startedAt = Date.now();
  let response;
  try {
    response = await ctx.ipcServer.request(target.extensionId, env, {
      timeoutMs: SESSION_PING_TIMEOUT_MS,
    });
  } catch (err) {
    return errorResponse(`session_ping failed: ${(err as Error).message}`, [
      'IPC request did not complete (timeout, send error, or NMH disconnect). Check the extension service worker console for errors and confirm the SW is connected to the host. If the SW responder is missing the session_ping handler, the request will time out.',
    ]);
  }

  const latencyMs = Date.now() - startedAt;

  if (response.error) {
    return errorResponse(
      `session_ping nmh error: ${response.error.message}`,
      [
        'NMH-mode rejected the request. Inspect the extension service worker console and the host stderr for the underlying error.',
      ],
    );
  }

  const pageWorld = readPageWorld(response.payload);
  const pageWorldError = readPageWorldErrorCode(response.payload);
  const pageWorldErrorMessage = readPayloadString(
    response.payload,
    'pageWorldErrorMessage',
  );
  const pageWorldSelfHealed = readPayloadBoolean(
    response.payload,
    'pageWorldSelfHealed',
  );

  const data = {
    hostVersion: ctx.hostVersion,
    extensionVersion: readPayloadString(response.payload, 'extensionVersion'),
    attachedTabId: readPayloadNumber(response.payload, 'attachedTabId'),
    extensionId: target.extensionId,
    latencyMs,
    pageWorld,
    ...(pageWorldError !== null ? { pageWorldError } : {}),
    ...(pageWorldErrorMessage !== null ? { pageWorldErrorMessage } : {}),
    ...(pageWorldSelfHealed ? { pageWorldSelfHealed: true } : {}),
  };

  const nextSteps = buildNextSteps(pageWorld, pageWorldError, pageWorldSelfHealed);

  return okResponse(data, nextSteps);
};

export const sessionPingTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'session_ping',
  description:
    "Sends a ping through the full MCP → IPC → NMH → SW → CS → page-world chain and returns round-trip metadata: { hostVersion, extensionVersion, attachedTabId, extensionId, latencyMs, pageWorld, pageWorldError?, pageWorldErrorMessage?, pageWorldSelfHealed? }. pageWorld is { url, title, readyState } read live from the active tab's MAIN-world page-world script. pageWorld is null with pageWorldError set (a typed code: cs_not_attached_refresh_tab | page_blocks_scripts | page_world_blocked | restricted_url | no_active_tab | cs_inject_failed) when the SW round-trip succeeded but the page-bridge half failed. The SW also auto-recovers tabs that loaded before the extension reload by programmatically re-injecting the content script and page-world bundle — when this works, pageWorld is populated and pageWorldSelfHealed:true. The tool's next_steps[] field carries imperative, code-specific guidance the AI should relay verbatim to the user. With no args, targets the single connected NMH (errors if zero or multiple). Pass extension_id to target a specific extension. CALL host_status FIRST to see which extensions are currently connected.",
  inputSchema,
  handler: sessionPingHandler,
});
