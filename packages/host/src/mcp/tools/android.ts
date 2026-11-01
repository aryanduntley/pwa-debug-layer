import { z } from 'zod';
import type { AndroidFailure } from '../../android_adb/bridge.js';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';

const NO_ANDROID: ToolResponse = errorResponse('Android support is not available in this host process', [
  'This host was started without the Android bridge (older build or test context). Rebuild/restart the pwa-debug host.',
]);

/** What to tell the user for each way reaching the phone can fail. */
const STEPS_BY_KIND: Readonly<Record<AndroidFailure['kind'], readonly string[]>> = Object.freeze({
  not_installed: [
    'adb (Android platform-tools) is not installed or not found. Ask the user to install it: https://developer.android.com/tools/releases/platform-tools (or their package manager, e.g. `sudo apt install adb`), or set ANDROID_HOME to their SDK.',
  ],
  no_device: [
    'No phone is visible to adb. Ask the user to: enable Developer options (Settings > About phone > tap Build number 7 times), turn on USB debugging (Settings > Developer options), connect the phone by USB (a data cable, not charge-only) and choose "File transfer" if asked. Then call pdl_android_devices again.',
  ],
  unauthorized: [
    'The phone is connected but has not trusted this computer. Ask the user to unlock the phone and tap "Allow" on the "Allow USB debugging?" prompt (tick "Always allow"). If no prompt appears: unplug and replug, or Developer options > Revoke USB debugging authorizations, then replug.',
  ],
  offline: [
    'adb sees the phone but it is offline. Ask the user to unplug and replug it; if it stays offline, run `adb kill-server` then `adb devices`.',
  ],
  multiple_devices: ['Several phones are connected. Call pdl_android_devices and pass serial.'],
  not_found: ['adb could not read the device. Retry; if it persists, replug the phone.'],
  failed: ['An adb command failed; see the error. Retry, or ask the user to replug the phone.'],
  no_socket: [
    'No browser is exposing DevTools on the phone. Chrome only exposes it while it is running: ask the user to open Chrome on the phone (any tab), then retry. For an app WebView, the app must enable WebView debugging (debug builds: WebView.setWebContentsDebuggingEnabled(true)).',
  ],
  ambiguous_socket: [
    'Several browsers/WebViews are debuggable. Pass socket: a socket name from pdl_android_devices, or "chrome" / "webview", or an app package.',
  ],
  attach_failed: [
    'Reached the phone browser but could not attach to a page. If several tabs are open pass url_contains or target_id; or pass open_url to open a fresh tab.',
  ],
});

const failure = (f: AndroidFailure): ToolResponse =>
  errorResponse(f.message, [
    ...STEPS_BY_KIND[f.kind],
    ...(f.candidates !== undefined && f.candidates.length > 0
      ? [`Tabs on the phone: ${f.candidates.map((c) => `${c.id.slice(0, 8)} ${c.url}`).join(' | ')}.`]
      : []),
    ...(f.sockets !== undefined && f.sockets.length > 0
      ? [`DevTools sockets: ${f.sockets.map((s) => `${s.socket}${s.package !== undefined ? ` (${s.package})` : ''}`).join(', ')}.`]
      : []),
  ]);

const devicesSchema = {};

const attachSchema = {
  serial: z.string().min(1).optional().describe('Device serial from pdl_android_devices; optional when one phone is connected.'),
  socket: z
    .string()
    .min(1)
    .optional()
    .describe('DevTools socket name, "chrome", "webview", or an app package. Default: Chrome.'),
  open_url: z
    .string()
    .min(1)
    .optional()
    .describe('Open a new tab at this URL on the phone and attach it (bridge present before the page loads).'),
  url_contains: z.string().min(1).optional().describe('Attach to the open tab whose URL contains this text.'),
  target_id: z.string().min(1).optional().describe('Attach to this tab id (or prefix).'),
  reload: z.boolean().optional().describe('Reload the attached tab so the bridge runs before the app code.'),
  reverse_ports: z
    .array(z.number().int().min(1).max(65535))
    .optional()
    .describe('Desktop ports to expose on the phone as localhost:<port> (adb reverse), e.g. [5173] for a dev server.'),
};

const devicesHandler = async (_args: Record<string, never>, ctx: ToolContext): Promise<ToolResponse> => {
  if (ctx.android === undefined) return NO_ANDROID;
  const r = await ctx.android.devices();
  if (!r.ok) return failure(r);
  const ready = r.devices.filter((d) => d.state === 'device');
  return okResponse(
    { adbPath: r.adbPath, devices: r.devices },
    r.devices.length === 0
      ? STEPS_BY_KIND.no_device
      : ready.length === 0
        ? r.devices.some((d) => d.state === 'unauthorized')
          ? STEPS_BY_KIND.unauthorized
          : STEPS_BY_KIND.offline
        : [
            'Attach with pdl_android_attach: pass open_url to open the app in a new tab (add reverse_ports for a desktop dev server), or url_contains to attach to a tab already open.',
            ...(ready.some((d) => (d.sockets ?? []).length === 0) ? STEPS_BY_KIND.no_socket : []),
          ],
  );
};

const attachHandler = async (
  args: z.infer<z.ZodObject<typeof attachSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  if (ctx.android === undefined) return NO_ANDROID;
  const r = await ctx.android.attach({
    ...(args.serial !== undefined ? { serial: args.serial } : {}),
    ...(args.socket !== undefined ? { socket: args.socket } : {}),
    ...(args.open_url !== undefined ? { openUrl: args.open_url } : {}),
    ...(args.url_contains !== undefined ? { urlContains: args.url_contains } : {}),
    ...(args.target_id !== undefined ? { targetId: args.target_id } : {}),
    ...(args.reload !== undefined ? { reload: args.reload } : {}),
    ...(args.reverse_ports !== undefined ? { reversePorts: args.reverse_ports } : {}),
  });
  if (!r.ok) return failure(r);
  return okResponse(r, [
    `Attached to the phone (${r.model ?? r.serial}). Pass extension_id: "${r.connectionId}" to the other pwa-debug tools: pdl_navigate, pdl_click, pdl_tap, pdl_swipe, react_tree, store_get_state, console_tail, network_tail, sw_status, ... The user sees every action live on the phone.`,
    ...(r.reversed.length > 0
      ? [`The phone can now open ${r.reversed.map((p) => `http://localhost:${p}`).join(', ')}.`]
      : []),
    'If framework or store tools find nothing that should be there, call pdl_android_attach again with url_contains and reload:true.',
    'Port forwards and reverses pwa-debug created are removed when the host shuts down. pdl_cdp_detach drops a page connection.',
  ]);
};

export const androidDevicesTool: ToolDef<typeof devicesSchema> = Object.freeze({
  name: 'pdl_android_devices',
  description:
    "List Android phones connected over adb, each with its authorization state (device / unauthorized / offline), model, and the DevTools sockets it exposes (Chrome, other Chromium browsers, debuggable app WebViews with their package). Use it before pdl_android_attach, or when attaching fails, to tell the user exactly what to do (install adb, enable USB debugging, accept the authorization prompt, open Chrome). Finds adb on PATH or in the Android SDK. No args.",
  inputSchema: devicesSchema,
  handler: devicesHandler,
});

export const androidAttachTool: ToolDef<typeof attachSchema> = Object.freeze({
  name: 'pdl_android_attach',
  description:
    "Attach pwa-debug to a page on an Android phone in one call: finds the phone over adb, forwards its browser's DevTools socket, optionally exposes desktop ports to the phone (reverse_ports, so http://localhost:<port> works there), then attaches to an open tab (url_contains / target_id / the only one) or opens a new tab at open_url. Returns a connection id to pass as extension_id to every other pwa-debug tool, so framework, store, PWA, interaction, evaluate, navigation and console/network/error capture all work on the phone. Args: { serial?, socket?, open_url?, url_contains?, target_id?, reload?, reverse_ports? }.",
  inputSchema: attachSchema,
  handler: attachHandler,
});

export const ANDROID_TOOLS = Object.freeze([androidDevicesTool, androidAttachTool]);
