# pwa-debug-layer — Plan

A browser-side debug layer that lets an AI (Claude Code via MCP) **see and act on a live web app** the way a developer with full DevTools open would — DOM, console, network, framework state, actions — as structured streams the model consumes natively.

## Goal

Eliminate the "user is the AI's eyes and hands" loop. Today, debugging a PWA with AI requires the human to copy/paste DOM snippets, describe console errors, screenshot UI state, and hand-execute clicks. This project replaces that with direct, structured access.

**One-line summary:** A WebExtension + native messaging host + MCP server, distributed as one installer, targeting Chromium-family browsers.

## Non-goals

- Forking or modifying Chromium itself.
- Building a new browser or replacement UI.
- Polished end-user UX. This is a developer/AI tool. No theming, no extension store-grade onboarding.
- Mobile browsers in v1.
- Firefox in v1 (planned for Phase 4).
- Multi-user / hosted SaaS. Local-first, runs on the developer's machine.

## Decisions locked in

1. **Architecture:** WebExtension (MV3) + native messaging host + MCP server. No Chromium fork.
2. **Target browser family:** Chromium-family. Same extension binary works in Chromium, Chrome, Brave, Edge, Thorium, Vivaldi. Primary dev target is open-source Chromium (sideload extension, no Web Store dependency).
3. **AI transport:** Model Context Protocol (MCP). Claude Code calls our tools natively as `mcp__pwa_debug__*`.

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
            │ (isolated world)   │  │ (MAIN world)       │  │ (Phase 3, optional)│
            │ - DOM observe      │  │ - React/Vue hooks  │  │ - Human inspector  │
            │ - Action exec      │  │ - fetch/XHR patch  │  │   of AI session    │
            │ - Bridge to SW     │  │ - Bus/RxJS taps    │  │                    │
            └────────────────────┘  └────────────────────┘  └────────────────────┘
                       └────────── live page (the PWA being debugged) ─────────┘
```

### Why three components, not one

- **Extension alone** can't host a long-lived MCP server. MV3 service workers get killed unpredictably; they can't open arbitrary local sockets; they can't persist large buffers.
- **Native host alone** has no in-page reach. It can't read `__REACT_DEVTOOLS_GLOBAL_HOOK__` or click a button.
- **MCP server alone** has no browser. It needs a transport into the page.

The three together: extension owns the page, native host owns persistence + MCP, MCP owns the AI contract. Each layer does what only it can do.

### One example flow

Claude calls `react.getState({ componentId: "abc123" })`:

1. MCP server (in native host) receives the tool call over stdio from Claude Code.
2. Native host writes a JSON message to the extension via the native messaging channel.
3. Extension service worker routes the message to the content script in the active (or specified) tab.
4. Content script forwards via `window.postMessage` to the page-world script.
5. Page-world script reads from React's devtools hook, serializes state, posts back.
6. Result bubbles back: page world → content script → service worker → native host → MCP response → Claude.

All synchronous-feeling from Claude's perspective; one tool call, one structured result.

## Capability matrix

| Capability                        | Owning layer                      | Mechanism                                              |
|-----------------------------------|-----------------------------------|--------------------------------------------------------|
| DOM read / query                  | Service worker (CDP) or content   | `DOM.querySelector`, `Accessibility.getFullAXTree`     |
| DOM mutation observation          | Page-world                        | `MutationObserver` (with framework-aware filtering)    |
| Console events                    | Service worker (CDP)              | `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`  |
| Network events (metadata)         | Service worker (CDP)              | `Network.*`                                            |
| Network bodies (request/response) | Page-world                        | `fetch`/`XHR`/`WebSocket` monkey-patch                 |
| React state / fiber tree          | Page-world                        | `__REACT_DEVTOOLS_GLOBAL_HOOK__`                       |
| Vue / Svelte / Solid              | Page-world                        | Framework devtools globals                             |
| Redux / Zustand / Pinia           | Page-world                        | DevTools extension API hook                            |
| Custom event buses / RxJS         | Page-world                        | Opt-in user instrumentation API                        |
| Action: click / type / scroll     | Service worker (CDP)              | `Input.dispatchMouseEvent`, `Input.insertText`         |
| Service worker activity           | Service worker (CDP)              | `ServiceWorker.*`                                      |
| Performance traces                | Service worker (CDP)              | `Performance.*`, `Tracing.*`                           |
| Persistent buffers (console/net)  | Native host                       | In-memory ring buffers + optional disk spill           |
| Replay / snapshot store           | Native host                       | rrweb-style event log                                  |
| MCP transport                     | Native host                       | stdio (default) or HTTP/WS (optional)                  |
| File system writes                | Native host                       | (extension can't do this in MV3)                       |

## MCP tool surface (initial draft)

Names use `mcp__pwa_debug__` prefix when registered. Grouped:

**Inspection (read):**
- `dom.snapshot(tab?, mode='ax'|'dom'|'both')` — returns AX tree by default; full DOM on request.
- `dom.query(selector, tab?)` — returns matching nodes with role/attrs/text.
- `dom.describe(nodeId)` — full attrs + computed style + bounding box.
- `console.tail(since?, level?)` — buffered console events.
- `console.errors(since?)` — only errors + unhandled rejections.
- `network.tail(since?, filter?)` — buffered request/response metadata.
- `network.body(requestId)` — request or response body.
- `react.tree(tab?)` — component hierarchy.
- `react.getState(componentId)` — props + state + hooks for a component.
- `store.get(name?)` — Redux/Zustand/Pinia state snapshot.
- `events.tail(since?)` — DOM events + custom user-instrumented events.
- `perf.trace(durationMs)` — capture a perf trace.

**Action (write):**
- `dom.click(selector|nodeId, tab?)`
- `dom.type(selector|nodeId, text, tab?)`
- `dom.scroll(selector|nodeId|coords, tab?)`
- `eval(expression, tab?)` — runs in page world, returns serializable result.
- `nav.goto(url, tab?)`
- `nav.reload(tab?)`

**Session:**
- `tabs.list()` — debuggable tabs.
- `tabs.attach(tabId)` — focus subsequent calls on this tab.
- `session.record(start|stop)` — toggle rrweb-style recording.
- `session.replay(id)` — re-emit a recorded session for analysis.

## Phased build plan

### Phase 0 — Validate the loop (1 day)

Before writing any code in this repo, install `chrome-devtools-mcp` (Google) and run an end-to-end debugging task with Claude Code against a real PWA. Goals:

- Confirm MCP-over-stdio works with Claude Code as expected.
- Identify the specific gaps that justify building this project (frame state, store state, persistent buffers, action ergonomics, custom events).
- Use those gaps to prioritize Phase 1+.

**Exit criteria:** A short notes file `phase0-findings.md` listing what `chrome-devtools-mcp` does well and what it can't do. This becomes the requirements doc for Phase 1.

### Phase 1 — MVP: parity foundation (1–2 weeks)

Stand up the three-component architecture with a minimal but production-quality MCP surface:

- WebExtension (MV3) skeleton: service worker, content script, page-world script, manifest with `debugger` + `nativeMessaging` permissions.
- Native messaging host: Node.js process, registered per-OS, MCP server using `@modelcontextprotocol/sdk`.
- Tools shipped: `dom.snapshot` (AX tree), `dom.query`, `dom.describe`, `console.tail`, `console.errors`, `network.tail`, `eval`, `dom.click`, `dom.type`, `tabs.list`, `tabs.attach`.
- Ring buffers in native host for console + network (default 5k entries, configurable).
- Single-tab focus model (one attached tab at a time).
- Sideload installer for Linux first; macOS + Windows installers in Phase 1.5.

**Exit criteria:** Claude Code can debug a non-trivial bug in a real PWA without the user copy/pasting any DOM or console output.

### Phase 2 — The differentiator: framework introspection (2–3 weeks)

This is what nothing off-the-shelf does well. Order of priority based on ecosystem reach:

- React (largest target). Tools: `react.tree`, `react.getState`, `react.findByText`, `react.findByRole`. Hook into the official `__REACT_DEVTOOLS_GLOBAL_HOOK__`.
- Redux / Zustand / Jotai. `store.get`, `store.subscribe`, `store.dispatch`.
- Vue 3. `vue.tree`, `vue.getState`. Pinia store integration.
- Svelte / Solid. Lower priority; ship if the hooks are stable.
- Custom-events API: small JS shim that PWA developers can opt into to expose their own bus / RxJS streams to the AI.

**Exit criteria:** AI can inspect component state, dispatch a Redux action, and observe the resulting state change — without any in-app instrumentation beyond the framework's own devtools support.

### Phase 3 — Recording, replay, multi-tab (2 weeks)

- rrweb-based session recording. AI can ask for a slice of recent activity in replayable form.
- Multi-tab: attach to multiple tabs, route by tab handle.
- Optional DevTools panel for the human to watch what the AI is seeing/doing in real time.
- Source-map resolution: when AI sees a stack trace from minified code, return the original source location.

### Phase 4 — Firefox port (variable)

Fork the manifest, swap `chrome.debugger` for Firefox's CDP shim (or RDP directly), retest framework hooks. Ship as a separate XPI.

### Phase 5+ (deferred)

- Mobile (Chrome on Android via remote debugging).
- Distribution-grade Web Store / AMO listings.
- Hosted/team mode (cloud-relayed sessions).

## Open questions to resolve before / during Phase 1

1. **`chrome.debugger` vs external `--remote-debugging-port`.**
   - `chrome.debugger`: extension attaches CDP from inside the user's normal browser. Pro: no separate process, works with user's real session. Con: yellow "X is debugging this browser" bar, single attacher per target.
   - External port: launch Chromium with `--remote-debugging-port=9222`, native host connects directly. Pro: no banner, multiple attachers OK. Con: requires launching the browser ourselves (or asking the user to add the flag), separates from the user's daily browser session.
   - **Recommendation:** Default to `chrome.debugger` for the extension's normal mode. Add an "external port" mode as a fallback for power users / CI.

2. **MCP transport: stdio vs HTTP/WS.**
   - Stdio is simpler, what `@modelcontextprotocol/sdk` defaults to, and what Claude Code expects for local servers. Start there. Add HTTP/WS later if multi-client (e.g. concurrent Claude + IDE plugin) becomes a need.

3. **Snapshot default: AX tree vs DOM tree.**
   - AX tree is ~10–50× smaller and already semantic. **Default to AX. Provide DOM on request.** Probably also expose a hybrid mode that returns AX with `domNodeId` cross-references for when the AI needs to drill in.

4. **React component identity across re-renders.**
   - Fiber identity is not stable across reconciliation. Need a stable ID scheme — likely path-based (e.g. `App > Sidebar > UserList[0]`) plus `displayName + key` fingerprinting. Open question whether to lean on the React DevTools backend's existing element IDs.

5. **Service worker keepalive in MV3.**
   - Chrome can kill the SW after ~30s idle. The native messaging port keeps the SW alive while connected, which is convenient — but if the user disconnects the host, SW dies and CDP attach drops. Plan: native host stays connected for the session; SW reattaches on reconnect.

6. **Permission scope.**
   - `<all_urls>` host permission + `debugger` is broad and will trigger an install warning. Acceptable for a developer tool. Consider an "active tab only" mode for users who want tighter scope.

7. **Native messaging packaging.**
   - Each OS has a different registration mechanism (Linux: `~/.config/<browser>/NativeMessagingHosts/*.json`, macOS: similar paths, Windows: registry). Plan: ship a single npm CLI installer that detects the browser and writes the right manifest.

## Repo layout (proposed)

```
pwa-debug-layer/
├── PLAN.md                    (this file)
├── extension/
│   ├── manifest.json
│   ├── service-worker.js
│   ├── content-script.js
│   ├── page-world.js
│   ├── hooks/
│   │   ├── react.js
│   │   ├── vue.js
│   │   └── stores.js
│   └── devtools-panel/        (Phase 3)
├── host/
│   ├── package.json
│   ├── src/
│   │   ├── main.js            (entrypoint, native messaging loop)
│   │   ├── mcp-server.js      (MCP tool registration + dispatch)
│   │   ├── buffers.js         (ring buffers)
│   │   └── tools/             (one file per tool group)
│   └── installers/
│       ├── linux.sh
│       ├── macos.sh
│       └── windows.ps1
├── shared/
│   └── protocol.ts            (message types between host and extension)
└── examples/
    └── react-pwa/             (test target for development)
```

## Code style

This project follows the same FP discipline as BrowserAIComm (see sibling `CLAUDE.md`):

- Pure functions, DRY, no OOP.
- Side effects (CDP calls, file I/O, network) at the edges; core logic pure.
- OOP library interfaces (Playwright, MCP SDK, Chrome APIs) wrapped in thin FP adapters.

## Success metric

A user can hand Claude Code a vague bug report ("the submit button does nothing on the settings page") and Claude can — without any further human input — open the page, find the button, attempt the click, observe the lack of network call or the console error, inspect the relevant component state, and propose a code-level fix.

If we hit that, the project succeeded.
