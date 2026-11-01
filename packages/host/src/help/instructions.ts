/**
 * Sent to the MCP client on initialize. Clients such as Claude Code place it in
 * the AI's system prompt, so it is the one piece of guidance an AI sees before
 * it calls any tool. Keep it short: orientation here, detail in pdl_help.
 */
export const SERVER_INSTRUCTIONS = [
  'pwa-debug gives you live, structured access to a web app or PWA running in the user\'s real browser, and lets you control it.',
  '',
  '- You drive the page yourself. Use pdl_navigate / pdl_new_tab to open URLs and pdl_click, pdl_fill, pdl_submit, pdl_key_press, pdl_tap, pdl_swipe, pdl_scroll (and the other pdl_* actions) to interact. Do not ask the user to navigate, click or type for you.',
  '- You read state as data, not pixels. console_tail, network_tail, error_tail, evaluate, the react_/vue_/svelte_/solid_ tools, store_/redux_ tools, sw_status, cache_*, storage_get and idb_* return structured JSON. You do not need screenshots to know what is on the page; take one only to judge visual layout.',
  '- session_record (rrweb) captures a session for later replay or a bug report. It is not needed to watch the page.',
  '- Start with host_status. If nothing is connected: pdl_check_setup, then pdl_launch_browser, then session_ping.',
  '- Phones (Android): the extension cannot run there, so pwa-debug attaches over adb. pdl_android_attach({ open_url, reverse_ports }) (or url_contains for an open tab) does it in one call; pass the returned connection id as extension_id to every tool. pdl_android_devices tells you what to ask the user if the phone is not ready. See pdl_help({ topic: "mobile" }).',
  '',
  'Call pdl_help for the full guide, pdl_help({ topic }) for a how-to, or pdl_help({ tool }) for any tool\'s parameters. Every response carries next_steps: follow them.',
].join('\n');
