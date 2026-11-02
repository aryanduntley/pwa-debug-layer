import type { HelpTopic } from './types.js';

const topic = (t: HelpTopic): HelpTopic =>
  Object.freeze({
    ...t,
    guide: Object.freeze([...t.guide]),
    tools: Object.freeze([...t.tools]),
  });

/** What pwa-debug can do, shown first in the pdl_help overview. */
export const HELP_CAPABILITIES: readonly string[] = Object.freeze([
  'Drive the page yourself: navigate, open tabs, click, fill, submit, type, scroll, drag and touch gestures (topic "control"). Do not ask the user to do these.',
  'Read what the page does as data: persistent console, network and error capture that survives reloads, plus evaluate (topic "reading_state"). No screenshots needed to read content.',
  'See inside the app: React/Vue/Svelte/Solid component trees and state (topic "frameworks"), and Redux/Zustand/Pinia/Jotai stores (topic "stores").',
  'Diagnose the PWA layer: service worker, caches, installability, storage, IndexedDB and version skew (topic "pwa").',
  'Capture library popups such as wallet modals, including shadow DOM, and correlate their failures (topic "popups").',
  "Work on the user's real logged-in profile, or a sandbox profile with the extension preloaded (topic \"browser\").",
  'Drive Android phones (Chrome tabs and installed PWAs) with the same tools: pdl_android_attach finds the phone over adb and attaches in one call (topic "mobile").',
  'Audit responsive layout across pages × widths × color schemes × app states in one call, with your own custom checks, grouped into distinct problems to verify (topic "layout").',
]);

/** The standard startup sequence, shown in the pdl_help overview. */
export const HELP_WORKFLOW: readonly string[] = Object.freeze([
  'host_status: confirm the host is installed and an extension is connected.',
  'If not connected: pdl_check_setup, then pdl_launch_browser (mode sandbox-persistent is the most reliable).',
  'session_ping: confirm the page in the active tab is reachable.',
  'pdl_navigate to the page under test, act with the pdl_* interaction tools, then read results with the tail, framework, store and PWA tools.',
  'Follow next_steps in every response.',
]);

/**
 * The pdl_help catalog. Every registered tool must appear in at least one
 * topic's `tools` list, and every listed tool must exist; tests enforce both,
 * so adding or renaming a tool forces this file to be updated.
 */
export const HELP_TOPICS: readonly HelpTopic[] = Object.freeze([
  topic({
    id: 'getting_started',
    title: 'Getting started',
    summary: 'What pwa-debug is for, the startup sequence and the habits that make it work well.',
    guide: [
      "pwa-debug connects you to a web app or PWA running in the user's real browser profile (logged-in sessions, real extensions). It reads framework, store, service-worker, cache and storage state as JSON, and it lets you drive the page.",
      'Startup sequence:',
      '1. host_status: is the host installed and is an extension connected (activeConnections)?',
      '2. Nothing connected? pdl_check_setup lists the gaps and the exact fixes.',
      '3. pdl_launch_browser opens a browser with the extension and a debug port (mode=sandbox-persistent preloads the extension; the default mode=existing uses the normal profile).',
      '4. session_ping confirms the full round trip reaches the page in the active tab.',
      'Then work directly:',
      '- Go to pages yourself with pdl_navigate (current tab) or pdl_new_tab. Do not ask the user to navigate.',
      '- Interact yourself with pdl_click, pdl_fill, pdl_submit, pdl_key_press, pdl_tap, pdl_swipe and the other pdl_* actions. See topic "control".',
      '- Read what happened from console_tail, network_tail and error_tail, and read app state from the framework and store tools. See topic "reading_state". No screenshots are needed to know what the page contains.',
      'Every response has next_steps written for you. Follow them; they carry the fix for the state you are actually in.',
    ],
    tools: ['host_status', 'pdl_check_setup', 'pdl_launch_browser', 'session_ping', 'pdl_help'],
  }),
  topic({
    id: 'control',
    title: 'Driving the page: navigation and interaction',
    summary: 'You can navigate, open tabs, click, type, submit, scroll and do touch gestures yourself.',
    guide: [
      'You control the page. Do not ask the user to navigate, click or type; do it and then read the result.',
      'Navigation: pdl_navigate({ url }) drives the active tab (or tab_id) and waits for load. pdl_new_tab({ url }) opens a tab and returns its tabId; pass that tabId to later calls to target it. The scheme may be omitted (https:// is assumed).',
      'Interaction tools all take one locator. Pick one way to find the element:',
      '- selector: a CSS selector.',
      '- role (+ name): ARIA role and accessible name, e.g. role="button", name="Save".',
      '- text (+ exact): visible text.',
      '- stable_id (+ framework): a component id from react_tree / vue_tree / svelte_components / solid_*, so you can act on a component by identity.',
      'If several elements match, add nth (0-based) or set require_unique=true to fail instead of guessing.',
      'Events are real native sequences (pointer, mouse, input, change, touch), so React and Vue delegated handlers fire and controlled inputs update.',
      'Touch gestures (pdl_tap, pdl_double_tap, pdl_long_press, pdl_swipe, pdl_pinch) take direction/distance/duration/steps, not hand-built coordinates.',
      'After acting, verify with data: error_tail for exceptions, network_tail for requests, the framework/store tools for state changes.',
    ],
    tools: [
      'pdl_navigate', 'pdl_new_tab',
      'pdl_click', 'pdl_dblclick', 'pdl_hover', 'pdl_focus', 'pdl_blur',
      'pdl_fill', 'pdl_type_sequence', 'pdl_key_press', 'pdl_submit',
      'pdl_check', 'pdl_uncheck', 'pdl_select_option',
      'pdl_scroll', 'pdl_drag',
      'pdl_tap', 'pdl_double_tap', 'pdl_long_press', 'pdl_swipe', 'pdl_pinch',
    ],
  }),
  topic({
    id: 'reading_state',
    title: 'Reading what the page is doing',
    summary: 'Console, network, errors and ad-hoc evaluation, as structured data.',
    guide: [
      'Capture runs continuously and survives navigations and reloads, so you can act first and read afterwards.',
      'console_tail, network_tail and error_tail are cursor-paginated and take one filter object: filter.level (console only), filter.pattern.include / .exclude (regex sources), filter.since / filter.until (cursors), filter.limit (1..1000). Pass the previous response\'s cursor as filter.since to get only new entries.',
      'error_tail includes uncaught errors and unhandled promise rejections with stacks. Resolve minified frames with source_map_resolve.',
      'evaluate runs one JavaScript expression in the page and returns a serialized value (16KB cap). Use it for anything the dedicated tools do not cover.',
      'recent_events is a quick, unfiltered look at the latest captured events of any kind.',
      'Prefer these over screenshots: they give exact text, values and errors. Take a screenshot (chrome-devtools-mcp) only to judge visual layout. To check layout across widths, color schemes or app states, use layout_sweep (topic "layout") instead of resizing and measuring by hand.',
    ],
    tools: ['console_tail', 'network_tail', 'error_tail', 'evaluate', 'recent_events', 'source_map_resolve'],
  }),
  topic({
    id: 'frameworks',
    title: 'Framework introspection',
    summary: 'React, Vue, Svelte and Solid component trees, state and lookup.',
    guide: [
      'React: react_tree lists components with stable ids; react_get_state returns props, state and hooks for one id; react_find_by_text / react_find_by_role find components by what they render.',
      'Vue 3: vue_tree, vue_get_state, vue_find_by_text, vue_find_by_role, with the same shape as React.',
      'Svelte: svelte_components lists rendered components with source locations (dev builds); find by text/role. Svelte exposes no instance state.',
      'Solid: solid_detect, then element-level find by text/role. No component tree or state without @solid-devtools.',
      'Stable ids survive re-renders, and the interaction tools accept them (stable_id + framework), so you can find a component and then click it.',
    ],
    tools: [
      'react_tree', 'react_get_state', 'react_find_by_text', 'react_find_by_role',
      'vue_tree', 'vue_get_state', 'vue_find_by_text', 'vue_find_by_role',
      'svelte_components', 'svelte_find_by_text', 'svelte_find_by_role',
      'solid_detect', 'solid_find_by_text', 'solid_find_by_role',
    ],
  }),
  topic({
    id: 'stores',
    title: 'Store introspection',
    summary: 'Read, subscribe to and dispatch on Redux, Zustand, Pinia and Jotai stores.',
    guide: [
      'store_get_state / store_subscribe / store_tail / store_dispatch work across Redux, Zustand, Pinia and Jotai through one contract; pass framework to pick a store when several exist.',
      'redux_* are the Redux-specific versions (JSONPath-lite slice extraction, change-delta tail).',
      'Subscribe first, act on the page, then tail to see exactly which state changed.',
      'Dispatch is off by default. It needs the setting capture.stores.allowDispatch=true (settings_set); ask the user before enabling it.',
    ],
    tools: [
      'store_get_state', 'store_subscribe', 'store_tail', 'store_dispatch',
      'redux_get_state', 'redux_subscribe', 'redux_tail', 'redux_dispatch',
    ],
  }),
  topic({
    id: 'pwa',
    title: 'PWA runtime diagnostics',
    summary: 'Service worker, caches, installability, storage and update/version-skew analysis.',
    guide: [
      'Start broad: pwa_status (display mode, controller, permissions, capability matrix) and sw_status (installing/waiting/active workers, and whether an update is stuck waiting).',
      '"Why is my update not showing?": sw_status for a waiting worker, then pwa_update_analyze, which correlates SW state, cache ages and recent 404s into a verdict.',
      'Stale content: cache_list, then cache_inspect for entry ages and headers, then cache_match to see which cache serves a URL.',
      "Won't install: pwa_installability returns gaps and fixes.",
      'Data: storage_get (localStorage/sessionStorage), idb_list then idb_query for IndexedDB. All reads are read-only.',
      'sw_lifecycle_tail streams updatefound/statechange/controllerchange events.',
      'pwa_snapshot captures one capped blob of SW, store, storage, IndexedDB and cache state for a bug report.',
    ],
    tools: [
      'pwa_status', 'sw_status', 'sw_lifecycle_tail', 'pwa_update_analyze',
      'cache_list', 'cache_inspect', 'cache_match', 'pwa_installability',
      'storage_get', 'idb_list', 'idb_query', 'pwa_snapshot',
    ],
  }),
  topic({
    id: 'layout',
    title: 'Responsive layout sweep',
    summary: 'One call checks many pages, widths, color schemes and app states for overflow, cut-off text, small tap targets, off-screen bars, edge contact, clipped rings, unresolved copy, plus your own custom checks. Findings are heuristics: verify each group before fixing.',
    guide: [
      'Use layout_sweep instead of writing your own resize-and-measure scripts. It runs in the background: it returns a job_id, then poll layout_sweep_status until status is done.',
      'Targets: a phone (pdl_android_attach, then pass its connection id as extension_id) or a browser started by pdl_launch_browser with the extension. A browser the user started themselves is refused, because the host needs its debug port to emulate the viewport.',
      'Each view gets real top-level emulation over CDP: viewport width/height/dpr/mobile and prefers-color-scheme. Phones check their own size first, then 360/390/430 by default.',
      'App states the URL cannot reach: states.discover (expression returning state keys), then states.hash_template (e.g. "#state={state}&lang={lang}&theme={scheme}") or states.apply (expression with `view` bound). states.dimensions adds crossed axes such as { lang: ["en","es"] }; states.reload reloads after applying for apps that read their hash only on load.',
      'Example: layout_sweep({ extension_id: "<phone connection>", base_url: "http://localhost:8080/pages/", pages: ["customer/4.01-search.html", "all/4.10-chat.html"], viewports: [{ width: 360 }, { width: 411 }, { width: 430 }], root_selector: ".phone", states: { discover: "[...document.querySelectorAll(\'[data-tool=state]\')].map(b => b.dataset.value)", hash_template: "#state={state}&lang={lang}&theme={scheme}", dimensions: { lang: ["en", "es"] } }, checks: { tap_target: { min: 44 }, text_patterns: { extra: ["\\[[a-z-]+:[\\w.]+\\]"] } } }). For a desktop dev server reached from a phone, attach with reverse_ports.',
      'Reading results: groups are distinct problems (numbers in element names ignored), most frequent first, page overflow always first because it makes other geometry findings unreliable. Fix the first group, then re-run on groups[].pages only. report_path has every finding.',
      'Serve pages over http(s) from a root that contains every asset they load: a page whose relative ../ scripts or styles 404 renders blank, and the sweep then reports "root_selector matched nothing" or page errors instead of layout. Pass full URLs, or base_url plus paths.',
      'What is not measured: hidden content (display:none, closed <details>, collapsed height:0 wrappers, screen-reader-only text) is skipped by every check.',
      'edge_contact: each side is measured against the nearest box that shows an edge there (a border on that side, a shadow, a background image, or a background that differs from the surface behind it), so divider rows and same-color rows are judged by their card. Text is measured by its drawn lines, not its block box. A control with no edge of its own (transparent input, text or icon button) is measured by what it draws; a control that shows its own edge fails only when it touches, and one spanning the whole box width (a banner or footer action) is treated as full-bleed by design.',
      'ring_clipped (knob min_px, default 1): outline / box-shadow ink cut off for good by the nearest scrolling or clipping ancestor on that axis (ink past what it can scroll to). Full-width panels are skipped on their flush sides. It only sees rings present while measuring: a :focus-visible or :hover ring needs states.apply to focus or hover the element first.',
      'Your own checks: custom_checks: [{ name, expression }] runs each expression in the page after the built-in checks, for every view. It sees `view` (page, width, height, scheme, state and your dimensions) and `pdl`: pdl.elements(selector?) gives visible, non-exempt elements under the root, plus pdl.isVisible, rect, style, px, name, signature, edges (visible box edges), ink (outline/shadow reach) and background. Return elements, strings, or { element?, message, signature? } items (one or a list; null/false = nothing found). Findings are named custom:<name> and group, screenshot and report like built-in ones. Example: custom_checks: [{ name: "price_wraps", expression: "pdl.elements(\'.price\').filter(e => e.getClientRects().length > 1)" }, { name: "tiny_text", expression: "pdl.elements(\'p,span,a,button,label\').filter(e => pdl.px(e, \'font-size\') < 12).map(e => ({ element: e, message: `${pdl.px(e, \'font-size\')}px text \"${pdl.name(e)}\"` }))" }]. Expressions must be synchronous; one that throws or returns something unusable becomes a job warning and the view still counts. Like evaluate, they need a page whose CSP allows eval.',
      'Verify before fixing: the checks are geometric heuristics over computed styles and rects, so a group can be a false positive (an intentional full-bleed design, an unusual widget, a state users never see). Before changing code or reporting a group as a bug, confirm it: look at its screenshot (screenshots: "first_per_group"), inspect the element with evaluate, or check it on the device. Tell the user which groups you confirmed and which you dismissed, and why. Desktop emulation of a phone width uses desktop fonts and scrollbars, so confirm important findings on a real phone.',
      'Noise control: exempt_selectors skips elements and their subtrees; checks.<name>: false turns a check off; contrast is off by default (approximate). screenshots: "first_per_group" saves one clipped PNG per group as evidence.',
      'layout_sweep_cancel stops after the current view; emulation and the starting URL are always restored.',
    ],
    tools: ['layout_sweep', 'layout_sweep_status', 'layout_sweep_cancel'],
  }),
  topic({
    id: 'popups',
    title: 'Library popups and wallet modals',
    summary: 'WalletConnect/RainbowKit/SDK modals, including shadow DOM, and their failures.',
    guide: [
      'popup_tail streams detected library popups (shadow-root and nested content included).',
      'popup_failures links a popup\'s auth/connect failure to the console errors and failed requests during its open window.',
      'For a flaky flow, popup_record start, reproduce, popup_record stop, then popup_replay (flat, primary or tree view). Recordings are immune to ring-buffer eviction.',
    ],
    tools: ['popup_tail', 'popup_failures', 'popup_record', 'popup_replay'],
  }),
  topic({
    id: 'recording',
    title: 'Recording and replay',
    summary: 'When to use session_record (rarely) and what it is for.',
    guide: [
      'You do not need to record to observe the page. Capture (console, network, errors, popups) is always on, and state tools read live.',
      'session_record start/stop records an rrweb session; session_replay pages through it. Use it to keep a reproducible sequence for a bug report or for later analysis, not to watch what is happening now.',
      'For popups specifically, popup_record is the targeted equivalent.',
    ],
    tools: ['session_record', 'session_replay'],
  }),
  topic({
    id: 'browser',
    title: 'Launching and managing the browser',
    summary: 'Profile modes, ports, status and closing.',
    guide: [
      'pdl_launch_browser modes:',
      "- existing (default): the user's normal profile. Attaches if the debug port is live; if the browser runs without one, it opens a new window and reports degraded. The extension must already be installed there (pdl_install_extension).",
      '- sandbox-persistent: a dedicated dev profile under ~/.pwa-debug/profiles/<browser>/ with the extension preloaded. Most reliable choice.',
      '- sandbox-temp: same, in a throwaway profile removed on shutdown.',
      'Args: browser (chrome|chromium|edge|brave|vivaldi|opera, default system browser), port (default 9222), packaging (native|snap|flatpak), isolateExtensions (sandbox only; false keeps other extensions), extraArgs (startup flags, cold spawn only).',
      'Branded Google Chrome 137+ no longer honours --load-extension, so sandbox preload does not work there; prefer Brave, Chromium or Edge for sandbox modes.',
      'pdl_browser_status shows managed launches with a live port re-probe; pdl_close_browser closes them.',
    ],
    tools: ['pdl_launch_browser', 'pdl_browser_status', 'pdl_close_browser'],
  }),
  topic({
    id: 'chrome_devtools',
    title: 'Working alongside chrome-devtools-mcp',
    summary: 'Which server to use for what, and how they share one browser.',
    guide: [
      'pwa-debug and chrome-devtools-mcp are separate MCP servers that share one browser. pdl_launch_browser opens it with a debug port; chrome-devtools-mcp attaches to that port via --browserUrl.',
      'Use pwa-debug for app state (framework, stores, SW, cache, storage), persistent console/network/error capture, navigation and interaction on the real profile.',
      'Use chrome-devtools-mcp for screenshots, performance traces, Lighthouse, device/network emulation and accessibility snapshots. For responsive layout audits use pwa-debug\'s layout_sweep, which does its own viewport and color-scheme emulation (topic "layout").',
      'pdl_register_chrome_devtools registers it pinned to the right port. It changes the user\'s global MCP config, so ask first. pdl_check_setup flags it if it is unregistered or pinned to the wrong port.',
    ],
    tools: ['pdl_register_chrome_devtools', 'pdl_check_setup'],
  }),
  topic({
    id: 'mobile',
    title: 'Phones and mobile testing',
    summary: 'Drive an Android phone (Chrome tab or installed PWA) with the same tools, in one attach call.',
    guide: [
      "The extension cannot run in Android Chrome, so pwa-debug reaches phones over adb + the DevTools Protocol. Once attached, every pwa-debug tool (framework, store, PWA, interaction, evaluate, console/network/error capture, navigation) works on the phone tab, and the user watches it happen on the phone.",
      'Tell the user up front what they need: Developer options + USB debugging on, phone on USB, "Allow USB debugging" accepted, and Chrome open on the phone. Do not wait for them to discover it.',
      '1. pdl_android_devices: lists phones with their state and DevTools sockets. Its next_steps say exactly what to ask the user when something is missing (adb not installed, unauthorized, offline, Chrome not running).',
      '2. pdl_android_attach in one call:',
      '   - testing a desktop dev server: pdl_android_attach({ open_url: "http://localhost:5173", reverse_ports: [5173] }) maps the port to the phone and opens the app in a new tab with the bridge in place before it loads;',
      '   - a tab already open on the phone: pdl_android_attach({ url_contains: "myapp" }) (add reload: true if a framework/store hook must exist at startup);',
      '   - an app WebView: socket: "webview" or the app package (the app must enable WebView debugging).',
      '3. Pass the returned connection id ("cdp:127.0.0.1:<port>:<tab>") as extension_id to every other tool: pdl_navigate, pdl_click, pdl_tap, pdl_swipe, react_tree, store_get_state, console_tail, network_tail, sw_status, ...',
      'pdl_new_tab with that extension_id opens further phone tabs (each its own connection). pdl_cdp_detach drops a connection. adb forwards/reverses pwa-debug created are removed when the host shuts down.',
      'layout_sweep works on a phone connection: it checks the phone\'s own size first, then the requested widths (topic "layout").',
      'Everything works on the phone except recent_events (use the tail tools instead). Capture settings (sites.allowlist / blocklist / readControls, capture.enabledKinds, capture.filters) apply to phone connections exactly as to the extension. If the tab crashes, calls say so; pdl_navigate reloads it.',
      'Manual fallback without the Android tools: `adb forward tcp:9223 localabstract:chrome_devtools_remote`, then pdl_cdp_targets / pdl_cdp_attach with browser_url "9223".',
      'The user can mirror the phone screen on the desktop at chrome://inspect/#devices (Inspect); pwa-debug does not need it.',
    ],
    tools: [
      'pdl_android_devices', 'pdl_android_attach',
      'pdl_cdp_targets', 'pdl_cdp_attach', 'pdl_cdp_detach',
      'pdl_tap', 'pdl_swipe', 'pdl_pinch', 'pdl_long_press',
    ],
  }),
  topic({
    id: 'targeting',
    title: 'Targeting a connection and a tab',
    summary: 'extension_id and tab_id, and what happens when several are connected.',
    guide: [
      'With no extension_id, tools target the single connected extension. If several are connected (several browsers or profiles), the call errors; pass extension_id from host_status activeConnections.',
      'With no tab_id, page tools target the active tab of the last-focused window. pdl_new_tab returns a tabId to pass explicitly.',
      'CDP connections (phones, browsers without the extension) have ids like "cdp:127.0.0.1:9223:AB12CD34" and appear in host_status activeConnections with kind "cdp". Pass that id as extension_id; tab_id is ignored because each CDP connection is exactly one tab.',
      'If session_ping returns pageWorld:null with a pageWorldError code, follow its next_steps (refresh the tab, Brave Shields, CSP, restricted URL, etc.).',
    ],
    tools: ['host_status', 'session_ping', 'pdl_android_attach', 'pdl_cdp_targets', 'pdl_cdp_attach'],
  }),
  topic({
    id: 'settings',
    title: 'Settings',
    summary: 'Capture filters, site allow/block lists, disk spill, launch defaults, store dispatch.',
    guide: [
      'settings_list_schema lists every key with type, default and description; settings_get reads current values; settings_set writes one (validated, applied live to the extension).',
      'Common keys: sites.allowlist / sites.blocklist, capture.enabledKinds, capture.diskSpill.*, launch.defaultPort, capture.stores.allowDispatch.',
    ],
    tools: ['settings_list_schema', 'settings_get', 'settings_set'],
  }),
  topic({
    id: 'setup',
    title: 'Installing and registering the host',
    summary: 'Native-messaging registration, the unpacked extension and resets.',
    guide: [
      'pdl_check_setup first: it reports every gap with the exact remediation.',
      'host_register_extension(id) / host_unregister_extension(id) add or remove an extension id across per-browser manifests; host_list_registrations reads them.',
      'pdl_install_extension copies the bundled extension to a folder for Load unpacked (Developer mode) in the normal profile. Sandbox launch modes do not need it.',
      'host_reset is destructive cleanup for re-bootstrapping; confirm with the user first.',
    ],
    tools: [
      'pdl_check_setup', 'host_register_extension', 'host_unregister_extension',
      'host_list_registrations', 'host_reset', 'pdl_install_extension', 'host_status',
    ],
  }),
  topic({
    id: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'The verification sequence and the common failure codes.',
    guide: [
      'Verify in order: host_status (installed? connected?) -> pdl_check_setup (gaps) -> pdl_browser_status (port live? extension heartbeat?) -> session_ping (page reachable?).',
      'No connection after launch: the extension id may not be whitelisted; pdl_check_setup detects it and gives the host_register_extension fix.',
      'session_ping pageWorldError codes: cs_not_attached_refresh_tab (hard-refresh the tab), page_blocks_scripts (content blocker / Brave Shields), page_world_blocked (site CSP), restricted_url (chrome://, Web Store, file://), no_active_tab.',
      'A tool times out: confirm with session_ping that the tab still responds; a navigation in flight or a frozen tab is the usual cause.',
    ],
    tools: ['host_status', 'pdl_check_setup', 'pdl_browser_status', 'session_ping'],
  }),
]);
