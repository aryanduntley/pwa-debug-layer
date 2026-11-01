import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';

const PHONE_HINT =
  'For an Android phone: forward its DevTools socket first with `adb forward tcp:9223 localabstract:chrome_devtools_remote` (run it yourself if you have a shell, otherwise give the user that command), then use browser_url "9223". To load a desktop dev server on the phone, also run `adb reverse tcp:<port> tcp:<port>` so the phone can open http://localhost:<port>.';

const NO_CDP: ToolResponse = errorResponse('CDP connections are not available in this host process', [
  'This host was started without the CDP transport (older build or test context). Rebuild/restart the pwa-debug host.',
]);

const targetsSchema = {
  browser_url: z
    .string()
    .min(1)
    .describe("Debug endpoint: a port ('9222'), 'host:port', or an http/ws URL."),
};

const attachSchema = {
  browser_url: z
    .string()
    .min(1)
    .describe("Debug endpoint: a port ('9222'), 'host:port', or an http/ws URL."),
  target_id: z.string().min(1).optional().describe('Page target id (or its prefix) from pdl_cdp_targets.'),
  url_contains: z.string().min(1).optional().describe('Attach to the page whose URL contains this text.'),
  reload: z
    .boolean()
    .optional()
    .describe('Reload after attaching so the bridge runs before the app code (needed for hooks that must exist at startup).'),
};

const detachSchema = {
  connection_id: z.string().min(1).describe("Connection id returned by pdl_cdp_attach ('cdp:...')."),
};

const targetsHandler = async (
  args: z.infer<z.ZodObject<typeof targetsSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  if (ctx.cdp === undefined) return NO_CDP;
  const r = await ctx.cdp.targets(args.browser_url);
  if (!r.ok) return errorResponse(r.error, [PHONE_HINT, 'Desktop: the port pdl_launch_browser reported (default 9222).']);
  return okResponse(
    {
      browserUrl: r.browserUrl,
      browser: r.version.browser,
      ...(r.version.androidPackage !== undefined ? { androidPackage: r.version.androidPackage } : {}),
      targets: r.targets.map((t) => ({
        id: t.id,
        connectionId: t.connectionId,
        attached: t.attached,
        title: t.title,
        url: t.url,
      })),
    },
    [
      r.targets.length === 0
        ? 'No page is open on this endpoint. Open one (on a phone: ask the user to open Chrome, or attach to any page and use pdl_new_tab).'
        : 'Attach with pdl_cdp_attach({ browser_url, target_id }) or url_contains. Already-attached pages show attached:true.',
    ],
  );
};

const attachHandler = async (
  args: z.infer<z.ZodObject<typeof attachSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  if (ctx.cdp === undefined) return NO_CDP;
  const r = await ctx.cdp.attach({
    browserUrl: args.browser_url,
    ...(args.target_id !== undefined ? { targetId: args.target_id } : {}),
    ...(args.url_contains !== undefined ? { urlContains: args.url_contains } : {}),
    ...(args.reload !== undefined ? { reload: args.reload } : {}),
  });
  if (!r.ok) {
    return errorResponse(r.error, [
      ...(r.candidates !== undefined && r.candidates.length > 0
        ? [`Pages on this endpoint: ${r.candidates.map((c) => `${c.id.slice(0, 8)} ${c.url}`).join(' | ')}. Pass target_id or url_contains.`]
        : []),
      PHONE_HINT,
    ]);
  }
  const status = (r.status ?? {}) as { captures?: string };
  return okResponse(
    {
      connectionId: r.connectionId,
      title: r.target.title,
      url: r.target.url,
      reused: r.reused,
      bridge: r.status,
    },
    [
      `Pass extension_id: "${r.connectionId}" to the other pwa-debug tools (session_ping, react_tree, pdl_click, store_get_state, console_tail, network_tail, pdl_navigate, ...). If this is the only live connection you may omit it.`,
      status.captures === 'skipped_extension_present'
        ? 'The pwa-debug extension is also running in this page, so console/network/error capture stays on the extension connection: read the tails with the extension id (host_status), not this one. Requests through this connection work normally.'
        : 'Capture is live: console, network and errors from this page now land in console_tail / network_tail / error_tail for this connection id.',
      'If framework/store tools find nothing that should be there, attach again with reload:true so the bridge is in place before the app starts.',
      'recent_events is not available over CDP; use the tail tools.',
    ],
  );
};

const detachHandler = async (
  args: z.infer<z.ZodObject<typeof detachSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  if (ctx.cdp === undefined) return NO_CDP;
  const detached = await ctx.cdp.detach(args.connection_id);
  return detached
    ? okResponse({ connectionId: args.connection_id, detached: true }, [
        'The page is left as it was; capture for this connection has stopped. Already-captured events stay queryable.',
      ])
    : errorResponse(`no CDP connection ${args.connection_id}`, ['host_status lists live connections (kind "cdp").']);
};

export const cdpTargetsTool: ToolDef<typeof targetsSchema> = Object.freeze({
  name: 'pdl_cdp_targets',
  description: `List the pages open on a Chrome DevTools Protocol endpoint (desktop debug port or an Android phone over adb), with the connection id each would get and whether it is already attached. Use it to reach pages the pwa-debug extension cannot run in: Android Chrome tabs, installed PWAs on a phone, or a desktop browser without the extension. Args: { browser_url }. ${PHONE_HINT}`,
  inputSchema: targetsSchema,
  handler: targetsHandler,
});

export const cdpAttachTool: ToolDef<typeof attachSchema> = Object.freeze({
  name: 'pdl_cdp_attach',
  description: `Attach pwa-debug to one page over CDP and inject its page-world bridge, so every pwa-debug tool (framework, store, PWA, interaction, evaluate, console/network/error capture, navigation) works on that page exactly as through the extension. Returns a connection id ('cdp:host:port:target') to pass as extension_id to the other tools. Picks the page by target_id, by url_contains, or the single regular page when only one is open. reload:true reloads so the bridge is present before the app starts. Args: { browser_url, target_id?, url_contains?, reload? }. ${PHONE_HINT}`,
  inputSchema: attachSchema,
  handler: attachHandler,
});

export const cdpDetachTool: ToolDef<typeof detachSchema> = Object.freeze({
  name: 'pdl_cdp_detach',
  description: 'Detach a CDP page connection made by pdl_cdp_attach: removes the injected bridge registration and stops capture for it. Args: { connection_id }.',
  inputSchema: detachSchema,
  handler: detachHandler,
});

export const CDP_TOOLS = Object.freeze([cdpTargetsTool, cdpAttachTool, cdpDetachTool]);
