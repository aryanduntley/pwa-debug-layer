/**
 * How each tool behaves on a CDP (phone) connection. Everything not listed
 * here works exactly as through the extension: the page-world bridge is the
 * same code. Tests check every name below is a registered tool.
 */
export type CdpSupportLevel = 'works' | 'host' | 'extension_only';

/** Not tied to a page connection; they behave the same whatever is attached. */
export const HOST_LEVEL_TOOLS: ReadonlySet<string> = new Set([
  'pdl_help',
  'host_status',
  'host_register_extension',
  'host_unregister_extension',
  'host_list_registrations',
  'host_reset',
  'pdl_check_setup',
  'pdl_install_extension',
  'pdl_launch_browser',
  'pdl_browser_status',
  'pdl_close_browser',
  'pdl_register_chrome_devtools',
  'settings_list_schema',
  'settings_get',
  'settings_set',
  'pdl_cdp_targets',
  'pdl_cdp_attach',
  'pdl_cdp_detach',
  'pdl_android_devices',
  'pdl_android_attach',
]);

/** Need the extension's service worker; refused on CDP connections with this guidance. */
export const EXTENSION_ONLY_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  recent_events:
    "recent_events reads the extension service worker's buffer, which CDP connections do not have. Use console_tail, network_tail or error_tail with this connection's id instead (same events, filterable, persistent).",
});

export const cdpSupportOf = (tool: string): CdpSupportLevel =>
  tool in EXTENSION_ONLY_TOOLS ? 'extension_only' : HOST_LEVEL_TOOLS.has(tool) ? 'host' : 'works';
