# pwa-debug-layer - Project Blueprint

**Version**: 1.0
**Status**: Initialized — discovery in progress (themes/flows/milestones pending)
**Last Updated**: 2026-04-26
**AIMFP Compliance**: Strict

---

## 1. Project Overview

### Idea

A browser-side debug layer that exposes live PWA state — DOM, framework component trees, store state, network, events, library popups — to AI agents via MCP. Eliminates the human "AI's eyes and hands" loop where developers manually copy/paste DOM snippets, describe console errors, and screenshot UI state. AI gains direct, structured, code-level access to everything the browser knows.

### Current Phase

**Initialized — Phase 2 of init complete (project record + infrastructure populated). Phase 3 (project_discovery) pending: themes, flows, completion path, milestones.**

### Goals

1. Eliminate the human copy/paste loop when AI debugs PWAs — full code-level visibility, no screenshot OCR.
2. Expose framework state (React/Vue/Svelte/Solid component trees, props, hooks) that CDP cannot reach.
3. Expose store state (Redux/Zustand/Pinia/Jotai) — read, subscribe, dispatch.
4. Capture shadow DOM, iframes, and dynamically-injected library widgets (e.g. WalletConnect modals, third-party SDK popups) that escape standard DOM tooling.
5. Provide persistent ring buffers + rrweb-style session replay across navigations and reloads.
6. Provide configurable filters so AI receives only relevant data per query — no full-DOM noise.
7. Auto-inject page-world hooks on every page load (no `initScript`-on-next-nav delay).
8. Ship as a single installer for Chromium-family browsers, complementary to chrome-devtools-mcp (zero tool-surface duplication).
9. FP-only codebase, no OOP — pure functions, immutability, side effects at edges.

### Success Criteria

- A user can hand Claude Code a vague bug report ("the submit button does nothing on the settings page") and Claude can — without further human input — open the page, find the button, click it, observe the lack of network call or the console error, inspect the relevant component state, and propose a code-level fix.
- AI can introspect a React component tree, read a Redux/Zustand store, and dispatch an action, all in a single MCP-tool round-trip.
- A WalletConnect-style third-party modal appearing on the page is captured (DOM, iframe content if same-origin, console events, network) and surfaced to AI.
- chrome-devtools-mcp + pwa-debug-layer run side-by-side against the same Chrome, same profile, same page, with zero CDP contention and no duplicated tool calls.
- Installer + manifest do not require `chrome.debugger` permission.

---

## 2. Technical Blueprint

### Language & Runtime

- **Primary Language**: TypeScript (Node 24.15.0, ESM)
- **Runtime/Framework**: Node 24 for native messaging host + MCP server; browser runtime for extension (MV3)
- **Build Tool**: rollup (TS → ESM bundle for host, IIFE bundle for page-world script, MV3-compatible bundle for extension)
- **Package Manager**: pnpm (workspaces)
- **Test Framework**: vitest

### Architecture Style

- **Paradigm**: Functional Procedural (AIMFP)
- **Pattern**: Pure functions with explicit data flow, effect isolation. OOP library interfaces (MCP SDK, Chrome APIs, native messaging) wrapped in thin FP adapters.
- **State Management**: Immutable data structures, Result-style error returns, no mutations in core logic. Mutable state confined to the host's ring buffer module and well-known browser-extension globals.

### Key Infrastructure

- `@modelcontextprotocol/sdk` — MCP server in the native host (stdio transport)
- WebExtension (MV3) — content script + page-world script + service worker, no `chrome.debugger`
- Native messaging host — Node process, JSON-over-stdio with the extension service worker; long-lived ring buffers for console/network/events
- rrweb — session record/replay (Phase 3)
- React/Vue/Svelte/Solid devtools globals (`__REACT_DEVTOOLS_GLOBAL_HOOK__`, etc.) — read-only introspection of framework state
- Redux DevTools API hook + Zustand/Pinia/Jotai exports — store state + dispatch

### Package Structure

```
pwa-debug-layer/
├── packages/                  ← source_directory
│   ├── extension/             (manifest.json, src/, tsconfig.json, rollup.config.mjs)
│   │   ├── src/
│   │   │   ├── service-worker.ts
│   │   │   ├── content-script.ts
│   │   │   ├── page-world.ts
│   │   │   └── hooks/         (react.ts, vue.ts, stores.ts, ...)
│   │   └── manifest.json
│   ├── host/                  (Node native messaging host + MCP server)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── main.ts        (native messaging entrypoint)
│   │   │   ├── mcp-server.ts  (MCP tool registration + dispatch)
│   │   │   ├── buffers.ts     (ring buffers, optional disk spill)
│   │   │   └── tools/         (one file per tool group)
│   │   └── installers/        (linux.sh, macos.sh, windows.ps1)
│   └── shared/                (protocol types — message schemas between host and extension)
│       └── src/protocol.ts
├── examples/                  (test target PWAs — react sample, etc.)
├── docs/                      (PLAN.md, goals.txt, notes.txt, future phase0-findings.md)
├── pnpm-workspace.yaml
├── package.json               (root, dev tooling only)
├── tsconfig.base.json
└── .aimfp-project/            (databases, blueprint, backups)
```

---

## 3. Project Themes & Flows

**Status**: Pending — to be defined in `project_discovery` phase. Anticipated themes:

- **MCP Surface** — tool registration, request/response routing, schema definitions
- **Native Host** — Node process, native messaging loop, ring buffers, persistence
- **Extension Runtime** — service worker, content script, page-world bridge
- **Framework Introspection** — React, Vue, Svelte, Solid hooks
- **Store Introspection** — Redux, Zustand, Pinia, Jotai integrations
- **Capture Pipeline** — DOM mutation observers, fetch/XHR/WS patches, shadow-DOM walking, iframe handling
- **Filtering & Data Shaping** — query-time filters, payload shaping, relevance scoping
- **Replay** — rrweb integration, snapshot store, replay tool surface
- **Installer & Distribution** — per-OS native messaging registration, extension packaging

Flows will be defined during discovery. Flow IDs will be assigned to every tracked file via `add_file_to_flow`.

---

## 4. Completion Path

The authoritative completion path lives in `.aimfp-project/project.db` (`completion_path` table) — query via `get_all_completion_paths()` or `get_milestones_by_completion_path(path_id)`. This blueprint section is a human-readable summary; the DB is source of truth.

**10 user-defined paths** (in order):

1. **Foundation** (`in_progress`) — repo scaffold + one end-to-end round-trip from Claude → host MCP → extension SW → page-world.
2. **Core Capture** — persistent ring buffers across navigations, shadow-DOM walking, iframe handling.
3. **React Introspection** — `react.tree`, `react.getState`, find-by-text/role with stable component identity.
4. **Store Introspection** — Redux + Zustand + Pinia + Jotai (read + dispatch).
5. **Vue/Svelte/Solid Introspection** — parity with React where devtools hooks are stable.
6. **Library Popup Capture** — WalletConnect / RainbowKit / SDK-modal patterns; canonical test target is the user's separate crypto PWA.
7. **Interaction Helpers and Filtering** — framework-aware actions, full filter pipeline, source-map resolution.
8. **Replay** — rrweb session record/replay.
9. **Installer and Documentation** — per-OS installers, README with canonical setup docs.
10. **Firefox Port** (deferred, kept on path so it's not forgotten).

**Plus 2 default post-completion paths**: `Added Features` (order 998) and `Updates` (order 999) — both `completed` by default; reopen when post-launch work is needed.

Milestones are fleshed out at the start of each path's activation, not bulk-defined up front (only Foundation has milestones today). Tasks are created one at a time during `project_progression`, never batched.

---

## 5. Evolution History

### Version 1 — 2026-04-26

- **Change**: Initial project setup. AIMFP init Phase 1 (mechanical) + Phase 2 (project record + infrastructure) complete.
- **Rationale**: Project planning is mature (`docs/PLAN.md`, `docs/goals.txt`, `docs/notes.txt`) and ready for tracked, FP-compliant implementation. AIMFP provides the discipline + tracking needed to keep the multi-package architecture coherent.
- **Scope decision**: Locked option B from `docs/notes.txt` — companion MCP filling chrome-devtools-mcp's gaps, no CDP-parity duplication. See decision note id 2.
- **Compatibility constraint**: chrome-devtools-mcp coexistence forces `chrome.debugger`-free design. See decision note id 3.
- **Layout migration**: PLAN.md's flat `extension/` + `host/src/` + `shared/` replaced with pnpm workspace under `packages/`. See evolution note id 4.

### Version 1.1 — 2026-04-26

- **Change**: AIMFP discovery and progression complete. Themes (10), flows (5), completion paths (10 + 2 post-completion), milestones for Foundation (5), state DB (`packages/.state/runtime.db`), and state operations (`packages/.state/state_operations.ts`) populated. First task and items created against milestone M1.
- **Source-of-truth shift**: AIMFP (this blueprint + `project.db`) is now the authoritative project state. `docs/PLAN.md` is demoted to historical reference and will not be revised. `phase0-findings.md` is dropped as a deliverable — its substance is captured in AIMFP decision note id 2.
- **.gitignore tightening**: Project-specific rules; removed unrelated boilerplate (Hardhat/Foundry, PM2). Added `node_modules/`, `coverage/`, `.aimfp-project/backups/`, log patterns. `docs/` remains tracked.

---

## 6. User Settings System

No preferences set yet. To be populated as user expresses coding-style or workflow preferences during work.

---

## 7. User Custom Directives System

**Status**: Not applicable — Use Case 1 (regular software development project, no custom automation directives).

---

## 8. Key Decisions & Constraints

### Architectural Decisions

- **Companion-MCP scope (option B)**: Drop CDP-parity tool surface. chrome-devtools-mcp owns CDP-level access. We own framework state, stores, persistence, replay, filters, library-popup capture. Two MCPs side-by-side, namespace `mcp__pwa_debug__*`. Zero overlap with `chrome-devtools-mcp` tools.
- **No `chrome.debugger`**: CDP allows one driver per target; Puppeteer (chrome-devtools-mcp) holds it. Our extension uses content scripts, page-world (`world: "MAIN"`) scripts, framework devtools globals, and monkey-patched `fetch`/`XHR`/`WebSocket`. Bonus: drops manifest install warning, eliminates the WebDriver banner.
- **Three-component architecture**: Extension (page reach) + Native Host (persistence + MCP server, long-lived) + MCP transport over stdio. MV3 service worker can't host a long-lived MCP server alone; native host has no in-page reach alone; MCP server alone has no browser. Each layer does what only it can do.
- **TypeScript ESM everywhere**: Matches chrome-devtools-mcp's stack; shared types between host and extension live in `packages/shared/`.
- **pnpm workspaces under `packages/`**: Multi-package layout (extension, host, shared) without the awkwardness of a single `src/`. Source directory in AIMFP = `packages/`.
- **rollup for bundling**: Page-world script needs IIFE output (no module loading in injected script context); host needs Node ESM bundle; rollup handles both cleanly.

### Constraints

- **FP Compliance Mandatory**: All code must be pure functional (no OOP, no mutations in core logic). Library APIs (MCP SDK, Chrome extension APIs, native messaging) wrapped in thin FP adapters at the edges.
- **chrome-devtools-mcp coexistence**: User setup is `chrome --remote-debugging-port=9222 --user-data-dir=<dev-profile>` + load our extension unpacked + start chrome-devtools-mcp with `--browser-url=http://127.0.0.1:9222`. Documented as the canonical setup.
- **No CDP from our side**: Our extension does not use `chrome.debugger`. All capture is via in-page mechanisms.
- **MV3 only**: Manifest V3, no V2 fallback. Service worker keepalive maintained by the native messaging port being held open by the host.
- **Chromium-family only in v1**: Firefox port deferred to Phase 4.
- **Local-first**: No hosted/SaaS mode in v1. All persistence on the developer's machine.

---

## 9. Notes & References

### Important Context

- `docs/PLAN.md` — historical reference; the original architecture plan that informed init. Superseded by AIMFP (this blueprint, completion paths in `project.db`, decision/evolution notes) as source of truth. Will not be revised; existing inaccuracies (Phase 1 scope, JS/TS mix, flat repo layout, Open Question #1 on `chrome.debugger`) are documented in notes 2-4 and reflected throughout this blueprint and the DB.
- `docs/goals.txt` — user's original problem statement and the response that introduced MCP + extension as the right shape.
- `docs/notes.txt` — Phase 0 gap analysis vs chrome-devtools-mcp; recommendation for option B that became our locked scope. Captured directly into AIMFP decision note id 2; no separate `phase0-findings.md` will be written.
- Test target: user is building a PWA cryptocurrency app in a separate project. That app's WalletConnect / wallet-modal / SDK-popup behavior is the canonical real-world test case for our library-popup capture goal.

### External References

- chrome-devtools-mcp (Google, MIT/Apache-2.0): https://github.com/ChromeDevTools/chrome-devtools-mcp — the upstream that owns the CDP-level surface.
- Model Context Protocol: https://modelcontextprotocol.io
- rrweb: https://github.com/rrweb-io/rrweb
- React DevTools backend protocol: hook key `__REACT_DEVTOOLS_GLOBAL_HOOK__`
