# pwa-debug-layer

A browser-side debug layer that lets an AI agent (e.g. Claude Code via MCP) **see and act on a live web app** the way a developer with full DevTools open would — DOM, console, network, framework state, store state, actions — as structured streams the model consumes natively.

The goal is to eliminate the "user is the AI's eyes and hands" loop. Today, debugging a PWA with AI usually means the human copy/pastes DOM snippets, describes console errors, screenshots UI state, and hand-executes clicks. This project replaces that with direct, structured access.

> **Status: working on Linux.** The full MCP→IPC→native-host→service-worker→page-world round-trip is live, and the debugging surface is shipped: console/network/DOM-mutation/lifecycle capture with persistent ring buffers + disk spill, React and Redux introspection, rrweb session record/replay, source-map resolution, and a one-call browser launcher (`pdl_launch_browser`) with `chrome-devtools-mcp` coexistence. macOS/Windows paths are implemented with unit coverage; manual round-trip retest currently runs on Linux. Firefox is not supported (it doesn't speak CDP). See [Roadmap](#roadmap).

## How it differs from `chrome-devtools-mcp`

Google's [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) gives an AI Chrome DevTools Protocol access (DOM, console, network, screenshots). That covers a lot.

`pwa-debug-layer` is **complementary** — it targets the things CDP can't reach:

- **Framework state.** React fiber trees, Vue reactive state, Svelte component graphs, Solid signals — read via the framework's own devtools hooks (`__REACT_DEVTOOLS_GLOBAL_HOOK__`, `__vue_app__`, `_vnode`, etc.). CDP can't see these.
- **Store state.** Redux / Zustand / Pinia / Jotai — read, subscribe, and dispatch.
- **Shadow DOM, iframes, dynamically-injected library widgets.** WalletConnect modals, third-party SDK popups, and other widgets that escape standard DOM tooling.
- **Page-world reach in general.** A MAIN-world script we inject reaches things isolated-world content scripts can't, and reaches them earlier than `initScript`-on-next-nav.
- **Persistent ring buffers + rrweb-style replay** across navigations and reloads.
- **Configurable filters** so the AI receives only the slice it asked for — no full-DOM noise.

The two are designed to coexist: install both, the AI uses each for what it does best, with zero tool-surface duplication.

## Architecture

```
┌──────────────────┐  MCP (stdio)  ┌──────────────────────────┐
│  Claude Code     │ ◄───────────► │  Native Messaging Host   │
│  (or any MCP     │               │  - MCP server            │
│   client)        │               │  - Ring buffers          │
└──────────────────┘               │  - Replay/snapshot store │
                                   └────────────┬─────────────┘
                                                │ Native Messaging
                                                │ (JSON over stdio)
                                                ▼
                                   ┌──────────────────────────┐
                                   │  Extension Service Worker│
                                   │  - chrome.debugger (CDP) │
                                   │  - Tab/router            │
                                   └────────────┬─────────────┘
                                                │
                       ┌────────────────────────┼────────────────────────┐
                       ▼                        ▼                        ▼
            ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
            │ Content Script     │  │ Page-World Script  │  │ DevTools Panel     │
            │ (isolated world)   │  │ (MAIN world)       │  │ (planned)          │
            │ - DOM observe      │  │ - React/Vue hooks  │  │ - Human inspector  │
            │ - Action exec      │  │ - fetch/XHR patch  │  │   of AI session    │
            │ - Bridge to SW     │  │ - Bus/RxJS taps    │  │                    │
            └────────────────────┘  └────────────────────┘  └────────────────────┘
                       └────────── live page (the PWA being debugged) ─────────┘
```

Three components, one installable unit:

- **Extension** owns the page (DOM, content scripts, page-world hooks).
- **Native host** owns persistence and the MCP server (long-lived, can hold buffers, can write files).
- **MCP** owns the AI contract.

Each does what only it can. See [`docs/PLAN.md`](docs/PLAN.md) for the full design.

## Browser support

**Chromium-family only**, sideloaded. Tested against:

- Chromium (native package)
- Google Chrome (`.deb` / `.rpm`)
- Brave Browser
- Microsoft Edge (Linux `.deb`)
- Vivaldi
- Opera

macOS Application Support paths and Windows HKCU-registry registration are implemented and have unit-test coverage; the manual round-trip retest currently runs on Linux.

### Snap browsers are not supported

If you installed your browser via **snap** (e.g. `snap install chromium` on Ubuntu), it will not work with `pwa-debug-layer`.

**Why:** snap's `home` interface allows the browser to *read* files in `$HOME` but blocks *exec* of any binary whose resolved path crosses a hidden directory (`~/.nvm/...`, `~/.config/...`). The native messaging host launcher and the node binary it invokes both live under hidden paths in a normal install, so spawn fails with `Permission denied` and the service worker reports `Native host has exited.` There is no fix on the extension/host side that doesn't require copying ~125 MB of node into a non-hidden install dir per registration; not worth the install bloat for a setup most distros let you avoid.

**What to do:** install your Chromium-family browser from a native package source instead:

- **Ubuntu/Debian:** `apt install chromium` from the universe repo if you've enabled the non-snap source, or `apt install brave-browser` / `microsoft-edge-stable` from their respective `.deb` repos. The Chromium tarball from chromium.org also works.
- **Fedora:** `dnf install chromium` is non-snap by default.
- **Arch:** `pacman -S chromium`.

Flatpak browsers are detected and have a manifest written, but flatpak confinement may also block exec — if it fails, run `flatpak override --user --filesystem=host <app-id>` and retry.

## Installation

### Prerequisites

- Node.js ≥ 20.19 (developed on 23.x)
- pnpm
- A Chromium-family browser **not installed via snap** (see above)
- An MCP-aware client (e.g. [Claude Code](https://docs.claude.com/en/docs/claude-code))

### 1. Build the host and extension

```sh
git clone https://github.com/<your-fork>/pwa-debug-layer
cd pwa-debug-layer
pnpm install
pnpm build      # builds packages/host/dist/main.js and packages/extension/dist/
pnpm test       # full workspace unit suite (shared + host + extension)
```

### 2. Add the host to your MCP client

For Claude Code, add to your `.mcp.json` (project-scoped) or `~/.claude/mcp.json` (global):

```json
{
  "mcpServers": {
    "pwa-debug": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/pwa-debug-layer/packages/host/dist/main.js"]
    }
  }
}
```

Restart Claude Code so it picks up the server.

### 3. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`, etc.) in your browser.
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select `packages/extension/dist/`.
4. Note the extension's ID (shown on the card). Or, ask Claude to discover it for you in the next step — the extension service worker logs `[pwa-debug/sw] id=<id>` on every boot.

### 4. Tell Claude to set it up

The host registration is **AI-driven**. Six MCP tools are exposed for setup; Claude calls them via a guided flow:

> **Set up pwa-debug. The extension ID is `<your-id>`** *(or omit the ID and Claude can fetch it from the SW console if you also have `chrome-devtools-mcp` installed.)*

Claude will:

1. Call `host_status` to see what's already registered.
2. Call `host_register_extension(id)` — this writes a per-browser native-messaging manifest into every detected install (Chromium-family native, macOS Application Support, Windows HKCU registry), and drops a launcher script with an absolute node path (so the host spawns under sandboxed PATH environments).
3. Tell you to reload the extension at `chrome://extensions`.
4. After reload, call `host_status` again to confirm the manifest is on disk and the SW is connecting.

When the round-trip works you'll see in the SW console (`Inspect views: service worker` on the extension card):

```
[pwa-debug/sw] connected to host
[pwa-debug/sw] pong …
[pwa-debug/sw] hello …          (5s after connect — host-pushed message proving bidirectional flow)
```

## Launching a browser + `chrome-devtools-mcp` coexistence

`pwa-debug` and `chrome-devtools-mcp` are **two separate MCP servers** that share one browser. `pwa-debug` launches (or attaches to) a Chromium browser with a live remote-debugging port; `chrome-devtools-mcp` attaches to that same port over CDP. No proxying, no version coupling.

Register both with your client. For Claude Code:

```sh
# pwa-debug (this project) — adjust the path to your checkout
claude mcp add pwa-debug --scope user -- node /absolute/path/to/pwa-debug-layer/packages/host/dist/main.js

# chrome-devtools-mcp (optional but recommended) — runs via npx, no global install
claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222
```

> The host has no `install`/`serve` subcommand — `dist/main.js` auto-detects its mode: launched by Chrome (argv starts with `chrome-extension://`) it runs as the native-messaging host; launched by your MCP client it runs as the MCP server.

Then let Claude drive setup and launch:

1. **`pdl_check_setup`** — reports `{ ok, gaps[], recommendations[] }`: whether `chrome-devtools-mcp` is reachable, the host manifest is installed, the extension dist is present, and an extension ID is registered. Follow its `next_steps` to close any gap.
2. **`pdl_install_extension`** — copies the extension to `~/Downloads/pwa-debug-extension` (or a `target` you pass) with `chrome://extensions` "Load unpacked" instructions. *(Skip this if you use a sandbox mode below — it preloads the extension.)*
3. **`pdl_launch_browser`** — launches/attaches a browser with the debug port live and returns the `browserUrl` to hand to `chrome-devtools-mcp`.
4. **`pdl_browser_status`** — shows what's been launched (browser, profile mode, port, pid), re-probes each debug port for liveness, and reports the extension service-worker heartbeat.

## Profile modes

`pdl_launch_browser` takes `mode` (default `existing`), `browser` (defaults to your system-default Chromium browser), and `port` (default `9222`).

| Mode | Profile | When to use |
|---|---|---|
| **`existing`** *(default)* | Your normal browser profile | Debugging your real browsing session. Degrades gracefully: **(a)** debug port already live → attaches; **(b)** browser running *without* a debug port → opens a new window in the existing session (your extension tools work, but `chrome-devtools-mcp` is unavailable until you fully quit + relaunch — Chrome only opens the debug port at process start); **(c)** browser not running → spawns fresh with the port + your profile (both tool surfaces work). |
| **`sandbox-persistent`** | `~/.pwa-debug/profiles/<browser>/` (persists across restarts) | Long-running dev work you don't want polluting your normal profile. Runs as a separate process beside your main browser, with the pwa-debug extension **preloaded** (no manual unpacked install, no content-script reload race). |
| **`sandbox-temp`** | a fresh `mktemp` dir (removed on host shutdown) | One-off / CI / clean-state runs. Same preloaded-extension benefit; the profile is discarded when the host stops. |

Sandbox modes always give you both tool surfaces because they own their own `--user-data-dir` (no profile-lock collision with your main browser) and load the extension before any tab opens.

## Browser support matrix

Chromium-family only (Firefox doesn't speak CDP). Linux is first-class. macOS/Windows binary detection, profile/user-data-dir paths, **and system-default detection** (macOS LaunchServices, Windows `UserChoice` registry) are all implemented with unit coverage, but **live verification on real macOS/Windows machines is still needed — see [Help wanted](#help-wanted-macos--windows-verification).**

| Browser | PATH names probed | Standard Linux binary | Linux profile dir (`existing` mode) |
|---|---|---|---|
| Chrome | `google-chrome`, `google-chrome-stable` | `/opt/google/chrome/chrome`, `/usr/bin/google-chrome*` | `~/.config/google-chrome` |
| Chromium | `chromium`, `chromium-browser` | `/usr/bin/chromium*`, `/snap/bin/chromium` | `~/.config/chromium` |
| Edge | `microsoft-edge`, `microsoft-edge-stable` | `/opt/microsoft/msedge/msedge` | `~/.config/microsoft-edge` |
| Brave | `brave-browser`, `brave` | `/opt/brave.com/brave/brave-browser` | `~/.config/BraveSoftware/Brave-Browser` |
| Vivaldi | `vivaldi`, `vivaldi-stable` | `/opt/vivaldi/vivaldi` | `~/.config/vivaldi` |
| Opera | `opera` | `/usr/bin/opera`, `/opt/opera/opera` | `~/.config/opera` |

- **System default:** the launcher prefers your system-default browser when you don't pass one — Linux via `xdg-settings get default-web-browser`, macOS via LaunchServices (`defaults read … LSHandlers`), Windows via the HKCU `UrlAssociations\http\UserChoice` ProgId. The macOS/Windows paths are implemented + unit-tested but not yet exercised on a real machine.
- **Default debug port** is `9222` (the `chrome-devtools-mcp` convention); override it without passing `port` each time via the `launch.defaultPort` setting (`settings.set`).
- **Snap profiles:** when launching a snap-packaged browser (`/snap/bin/…`) in `existing` mode, the launcher now resolves its confined profile (`~/snap/<snap>/common/<cfg>`) instead of `~/.config` — but note snap browsers still can't run the native-messaging host (see snap section), so this only matters if/when that confinement is lifted.
- **Brave Shields** can block the content script on a site — set Shields **Down** for the site if `session_ping` reports `page_blocks_scripts`.
- **Snap browsers are unsupported** for the native-messaging host (see below); the launcher can still spawn them, but the host round-trip won't connect. Use a native-package browser.
- **Flatpak** installs get a manifest written, but confinement may block exec — run `flatpak override --user --filesystem=host <app-id>` and retry.

## Help wanted: macOS / Windows verification

Development happens on Linux, so the macOS and Windows code paths are **written and unit-tested with injected fakes, but never run on a real machine.** If you're on macOS or Windows, trying these and reporting back (open an issue with the output) is the single most useful contribution right now:

**macOS**
- `pdl_check_setup` / `pdl_install_extension` — does the extension resolve and copy, and do the `chrome://extensions` instructions work?
- Browser binary detection under `/Applications/*.app/Contents/MacOS/…`.
- System-default detection: `defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers` — does the parser pick the right browser? (Paste the raw output if it doesn't.)
- `pdl_launch_browser` mode `existing` (profile under `~/Library/Application Support/…`) and both sandbox modes.

**Windows**
- Browser detection under `%PROGRAMFILES%` / `%LOCALAPPDATA%`.
- System-default detection: `reg query "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" /v ProgId` — does the ProgId map to the right browser?
- `pdl_launch_browser` (profile under `%LOCALAPPDATA%\…\User Data`) and the HKCU native-messaging registration.

**Any OS**
- `pdl_browser_status` after restarting the host — launches now persist to `launches.json`, so previously-launched browsers should still be listed (with a fresh liveness re-probe). Confirm the list survives a restart and that closed browsers show as not-live.

The launcher never kills your running browser and sandbox modes use throwaway/dedicated profiles, so this is low-risk to try.

## Troubleshooting

### Verification sequence

When something isn't working, walk this ladder — each step localizes the failure:

1. **`pdl_check_setup`** — are all setup gaps closed? (CDP reachable, manifest installed, extension present, ID registered.)
2. **`pdl_browser_status`** — is a browser launched and is its debug port still live? Is the extension service worker connected (recent heartbeat)?
3. **`host_status`** — is the native-messaging host registered and is an NMH instance connected?
4. **`session_ping`** — does a full MCP → SW → page-world round-trip succeed on the active tab? (See the typed `pageWorldError` table below.)

### Common launcher gotchas

- **"I launched in `existing` mode but `chrome-devtools-mcp` can't attach."** Chrome enables `--remote-debugging-port` only at process start. If the browser was already running without it, `pdl_launch_browser` opens a new window (sub-state **b**) but cannot add the port to the live process — `attached:false`. Fully quit the browser and re-run, or use `mode: sandbox-persistent` for a guaranteed debug port.
- **Brave/Chrome says "Opening in existing browser session."** That's sub-state **b** — the binary handed your request to the already-running process instead of starting a fresh one with the port. Same fix as above.
- **Added the MCP server but the tools don't appear.** `.mcp.json` / client MCP config is read at startup — restart your MCP client after adding `pwa-debug` or `chrome-devtools`.
- **Tools worked, then stopped after I reloaded the extension.** Reloading the extension at `chrome://extensions` detaches content scripts from already-open tabs. Hard-refresh the page tab (Ctrl+Shift+R); the SW also auto-reinjects on the next `session_ping` (look for `pageWorldSelfHealed: true`). Sandbox modes avoid this entirely (extension preloaded before tabs open).


### `session_ping` returns `pageWorld: null` with a typed `pageWorldError`

`session_ping` reports failure modes as **typed codes** in `pageWorldError` (machine-readable) plus the original chrome-runtime string in `pageWorldErrorMessage` (for logs). The MCP `next_steps[]` field carries imperative, code-specific guidance — AI clients should relay it verbatim. Tabs that simply predated the extension reload (the most common dev-loop friction) are auto-recovered by the SW via `chrome.scripting.executeScript`; when that succeeds, `pageWorld` is populated and `pageWorldSelfHealed: true` appears alongside it. The table below is the canonical mapping (single source of truth: `NEXT_STEPS_BY_CODE` in `packages/host/src/mcp/tools/session_ping.ts`).

| `pageWorldError` | What it means | What to do |
|---|---|---|
| *(absent)* with `pageWorldSelfHealed: true` | The static content script was missing on the active tab; the SW silently re-injected `content-script.js` + `page-world.js` and retried. No action needed. | Informational only. |
| `cs_not_attached_refresh_tab` | Auto-recovery was attempted but did not stick (page rejected the injection or reloaded mid-flight). | Hard-refresh the page tab (Ctrl+Shift+R) and retry. If it repeats, reload the extension at `chrome://extensions` then hard-refresh. |
| `page_blocks_scripts` | A content blocker is rejecting the script (Brave Shields, uBlock Origin, AdGuard, or similar). Site CSP is also possible. | **Brave:** click the lion icon → set Shields **Down** for the site → refresh → retry. **uBlock Origin / similar:** disable for this site → refresh → retry. If neither, the site's own CSP is blocking and pwa-debug cannot bypass it. |
| `page_world_blocked` | The content script attached but the MAIN-world page-world bridge cannot be reached — the site's Content-Security-Policy blocks the inline script tag. | Site-level restriction; cannot bypass. Console + network capture may still work via the content-script side, but live page-world reads (state, evaluate) will not. |
| `restricted_url` | The active tab is on a URL browsers do not allow extensions to touch (`chrome://`, `chromewebstore.google.com`, `about:`, `devtools://`, `file://`, `view-source:`, etc.). | Switch focus to a regular `http(s)` tab of the PWA, then retry. |
| `no_active_tab` | No active `http(s)` tab is focused (DevTools window or extension popup may be focused instead). | Focus a regular browser tab and retry. |
| `cs_inject_failed` | The auto-recovery `chrome.scripting.executeScript` itself failed. The extension cannot reach this tab. | Reload the extension at `chrome://extensions` and hard-refresh the page (Ctrl+Shift+R). If it persists, the URL may be one the browser blocks all extensions from — check the address bar. |

To confirm the content script attached after a successful round-trip, open the page tab's DevTools (F12 on the page itself, **not** the SW console) and look for `[pwa-debug/cs] attached at <url>` in the Console.

## MCP tool surface

Every tool returns a structured response of the form `{ ok, data, error?, next_steps[] }`. The `next_steps` array encodes the rules of engagement for the AI — what to call next based on the actual response shape — mirroring the AIMFP `return_statements` pattern. The canonical list lives in `packages/host/src/mcp/tools/index.ts`.

### Host management & setup

| Tool | Purpose |
|---|---|
| `host_status` | Install/liveness state: registered IDs, manifest paths, launcher path, active connections. Cheap, idempotent. **Always call first.** |
| `host_register_extension(id)` / `host_unregister_extension(id)` | Add/remove an extension ID across per-browser manifests + launcher script. Idempotent. |
| `host_list_registrations` / `host_reset` | Read registered IDs; destructive cleanup to re-bootstrap. |
| `session_ping` | Full MCP → IPC → NMH → SW → page-world round-trip with typed `pageWorldError` codes + self-heal. |
| `pdl_check_setup` | Diagnose setup → `{ ok, gaps[], recommendations[] }` (CDP reachable, manifest installed, extension present, ID registered). |
| `pdl_install_extension({ target? })` | Copy the extension to a folder for unpacked install. |

### Browser launcher

| Tool | Purpose |
|---|---|
| `pdl_launch_browser({ browser?, port?, mode? })` | Launch/attach a Chromium browser with a live debug port. `mode`: `existing` (default), `sandbox-persistent`, `sandbox-temp`. Returns `browserUrl` for `chrome-devtools-mcp`. |
| `pdl_browser_status` | Managed launches (browser, profile mode, port, pid) with live debug-port re-probe + extension SW heartbeat. |

### Page-level debugging

| Tool | Purpose |
|---|---|
| `console_tail` / `network_tail` | Cursor-paginated, filterable tails of the persistent capture ring buffers (memory + disk spill). |
| `recent_events` | Recent captured events across kinds for quick verification. |
| `evaluate` | Evaluate an expression in the page world. |
| `react_tree` / `react_get_state` / `react_find_by_text` / `react_find_by_role` | React fiber-tree introspection + component lookup. |
| `redux_get_state` / `redux_subscribe` / `redux_tail` / `redux_dispatch` | Redux store read, change-delta subscribe/tail, and (opt-in) dispatch. |
| `session_record` / `session_replay` | rrweb session recording + cursor-paginated replay. |
| `source_map_resolve` | Resolve generated stack frames to original `src/…:line:col`. |
| `settings_list_schema` / `settings_get` / `settings_set` | Read the typed settings schema; get/set values (allowlist, capture filters, disk-spill, etc.). |

## Roadmap

- **Foundation** ✅ — pnpm workspace + build pipeline; MV3 extension loads cleanly; native-messaging round-trip; AI-managed host registration; cross-platform install (Linux native + macOS + Windows registry; snap unsupported); MCP↔IPC↔NMH↔SW bridge.
- **Capture** ✅ — console / network (fetch/XHR/WebSocket) / DOM-mutation / lifecycle producers; host ring buffers with disk spill + archive pruning; filterable, cursor-paginated `console_tail` / `network_tail`.
- **Introspection** ✅ — React fiber tree + component lookup; Redux read/subscribe/dispatch; page-world `evaluate`.
- **Replay & source maps** ✅ — rrweb `session_record` / `session_replay`; `source_map_resolve` for stack frames.
- **Settings** ✅ — typed schema store (allowlist/blocklist, per-kind capture filters, per-site read controls, disk-spill).
- **Browser launcher** ✅ — `pdl_launch_browser` (existing + sandbox-persistent + sandbox-temp), `pdl_check_setup`, `pdl_browser_status`, `pdl_install_extension`, and `chrome-devtools-mcp` coexistence.
- **Next** — DevTools panel for human observation of an AI session; Vue/Pinia + Svelte/Solid + Zustand/Jotai store adapters; multi-tab routing model.
- **Deferred** — Firefox port (needs WebDriver BiDi, not CDP); macOS/Windows live verification ([help wanted](#help-wanted-macos--windows-verification)); mobile; hosted/team mode.
- **Intentionally not pursued** — **Chrome Web Store distribution.** The extension grants broad page access (DOM, framework state, stores, network) and is only meaningful alongside its MCP host. It ships **bundled with the MCP only** and is installed via a manual, dev-mode "Load unpacked" (`pdl_install_extension` hands you the path + steps) — so every user knows exactly what they're running and why. Disabling Chrome Developer mode auto-disables it.

## Code style

- FP-only: pure functions, immutability, no OOP, no classes-with-methods.
- Side effects (CDP calls, file I/O, native messaging, MCP transport) at the edges; core logic pure.
- OOP library interfaces (Chrome APIs, MCP SDK, `winreg`) wrapped in thin functional adapters with injection points for tests.

## Repo layout

```
pwa-debug-layer/
├── packages/
│   ├── host/                Native-messaging host + MCP server (Node, ESM, rollup-bundled)
│   ├── extension/           WebExtension (MV3) — service worker, content script, page-world
│   └── shared/              Cross-package types
├── docs/
│   ├── PLAN.md              Full design doc (architecture, capability matrix, phased plan)
│   └── goals.txt
├── examples/                (future: test PWAs)
└── reference/               Read-only reference checkouts
```

## Contributing

This is a personal project under active redesign. PRs welcome but please open an issue first to discuss scope — the architecture is still settling. The FP / no-OOP discipline applies to all contributions; see `CLAUDE.md` for the full rules.

## License

TBD.
