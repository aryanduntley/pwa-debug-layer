# pwa-debug-layer

A browser-side debug layer that lets an AI agent (e.g. Claude Code via MCP) **see and act on a live web app** the way a developer with full DevTools open would — DOM, console, network, framework state, store state, actions — as structured streams the model consumes natively.

The goal is to eliminate the "user is the AI's eyes and hands" loop. Today, debugging a PWA with AI usually means the human copy/pastes DOM snippets, describes console errors, screenshots UI state, and hand-executes clicks. This project replaces that with direct, structured access.

> **Status: early development.** M3 (native-messaging round-trip + AI-managed host registration) is in progress. The MVP debugging tools (`dom.snapshot`, `react.tree`, `console.tail`, etc.) are designed but not yet implemented. See [Roadmap](#roadmap).

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
pnpm test       # 92 unit tests at the time of writing
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

## Troubleshooting

### `session_ping` returns `pageWorld: null` with `pageWorldError: "Could not establish connection. Receiving end does not exist."`

The SW round-trip succeeded but the page-bridge half failed: the active tab has no content script listening. Check, in order:

1. **Brave Shields (or another per-site blocker) is blocking the content script.** This is the trickiest case because the SW still sees the tab as available — only the static `content_scripts` injection silently fails. In Brave: click the lion icon in the address bar and toggle Shields **down** for the site (or set Trackers & ads blocking to "Standard"/"Allow"). Other Chromium browsers can produce the same symptom via uBlock Origin Lite, AdGuard, or strict site settings — disable them for the page and retry.
2. **The tab predates the latest extension reload.** Static `content_scripts` registered in `manifest.json` only attach on navigation, not retroactively. Refresh the tab (Ctrl+R) after reloading the extension at `chrome://extensions`.
3. **The page is `chrome://`, the extension store, `about:blank`, or a PDF viewer.** Content scripts cannot run on these. Open a normal `http(s)` tab.
4. **The wrong tab is active.** The SW currently picks the tab via `chrome.tabs.query({active:true, lastFocusedWindow:true})`. If you have multiple browser windows open, make sure the window holding the tab you want is the most recently focused one.

To confirm the content script *did* attach, open the page tab's DevTools (F12 on the page itself, **not** the SW console) and look for `[pwa-debug/cs] attached at <url>` in the Console.

## MCP tool surface

### Available today (host management)

These ship in M3. They configure the native-messaging host itself; they do not yet expose page-level debugging.

| Tool | Purpose |
|---|---|
| `host_status` | Reports install/liveness state: registered IDs, manifest paths, launcher path, active connections. Cheap, idempotent. **Always call first.** |
| `host_register_extension(id)` | Adds an extension ID to allowed origins; writes per-browser manifests; emits launcher script. Idempotent. |
| `host_unregister_extension(id)` | Removes an extension ID; deletes manifests if it was the last one. |
| `host_list_registrations` | Cheap read of registered IDs from state file. |
| `host_reset` | Destructive cleanup — removes all registrations and manifests. Use to re-bootstrap from scratch. |
| `session_ping` | Round-trip test through MCP → IPC → NMH → SW. Currently returns `hostUnreachable: true` until the IPC bridge ships in M3 final / M4. |

Each tool returns a structured response of the form `{ ok, data, error?, next_steps[] }`. The `next_steps` array encodes the rules of engagement for the AI — what to call next based on the actual response shape — mirroring the AIMFP `return_statements` pattern.

### Planned (page-level debugging — Phase 1+)

Names and grouping are the design target; signatures may shift during implementation. See [`docs/PLAN.md`](docs/PLAN.md) for the full spec.

- **Inspection:** `dom.snapshot`, `dom.query`, `dom.describe`, `console.tail`, `console.errors`, `network.tail`, `network.body`, `react.tree`, `react.getState`, `store.get`, `events.tail`, `perf.trace`
- **Action:** `dom.click`, `dom.type`, `dom.scroll`, `eval`, `nav.goto`, `nav.reload`
- **Session:** `tabs.list`, `tabs.attach`, `session.record`, `session.replay`

## Roadmap

- **M1** ✅ — pnpm workspace, build pipeline, manifest, SW/CS/page-world skeletons, framework-detection probe.
- **M2** ✅ — extension loads cleanly in Chromium with no console errors.
- **M3** 🟡 *(in progress)* — native-messaging round-trip, AI-managed host registration, cross-platform install (Linux native + macOS + Windows registry; snap intentionally unsupported).
- **M4** — IPC bridge between MCP-mode and NMH-mode so `session_ping` and tool calls actually flow through the SW. Multi-tab focus model.
- **Phase 1 MVP** — first usable debugging surface: `dom.snapshot` (AX tree), `console.tail`, `network.tail`, `eval`, `dom.click`, `dom.type`. End-to-end goal: Claude debugs a non-trivial PWA bug without the user copy/pasting any DOM or console output.
- **Phase 2** — framework introspection: React, Redux/Zustand/Jotai, Vue/Pinia, Svelte/Solid. Custom-events opt-in API.
- **Phase 3** — rrweb session recording/replay, multi-tab routing, optional DevTools panel for human observation, source-map resolution.
- **Phase 4** — Firefox port.
- **Deferred** — mobile, Web Store distribution, hosted/team mode.

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
