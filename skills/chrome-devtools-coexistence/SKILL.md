---
name: chrome-devtools-coexistence
description: Use when registering or troubleshooting the optional chrome-devtools-mcp server alongside pwa-debug — making its tools available (full restart for a direct MCP install vs. /reload-plugins for a plugin install) and handing the user a context note to paste back across a restart so the conversation continues seamlessly.
---

pwa-debug and chrome-devtools-mcp are **two separate MCP servers**. pwa-debug
exposes framework/store/DOM state; chrome-devtools-mcp drives the browser
(snapshots, input, performance). They share **one** browser: `pdl_launch_browser`
spawns it with the debug port live, and chrome-devtools-mcp **attaches** to that
port via `--browserUrl`. This skill covers making chrome-devtools-mcp's tools
*appear* after you register it, and preserving context across the restart that
sometimes requires.

## When to use

- Right after `pdl_register_chrome_devtools` (or a manual `claude mcp add chrome-devtools …`).
- When the user reports that chrome-devtools tools are not available even though the registration looks correct.
- When `pdl_check_setup` reports chrome-devtools-mcp as not registered, **unpinned** (no `--browserUrl` → it spawns its own isolated browser instead of attaching to the pwa-debug browser), or pointed at the wrong port.

## The one rule that drives everything

**A newly added or re-pinned MCP server only takes effect when Claude Code (re)connects it.** How you trigger that depends on the install mode:

| Install mode | How chrome-devtools tools (re)load | Full restart? | Context lost? |
| --- | --- | --- | --- |
| **Direct MCP** (`claude mcp add …`) | `/mcp` → **reconnect** the server, or restart Claude Code | Usually **no** (reconnect) | Only if you full-restart — see handoff |
| **Plugin** (bundled MCP server) | Enable in `/plugins`, then run **`/reload-plugins`** | **No** (same session) | No |

**`/mcp` reconnect picks up a *changed* registration.** Verified in practice: after
`claude mcp remove chrome-devtools` + `claude mcp add … --browserUrl http://127.0.0.1:<port>`,
a `/mcp` → reconnect on `chrome-devtools` reloaded it with the new `--browserUrl`
and it attached to the pwa-debug browser — **no full restart, no context loss.**
Try `/mcp` reconnect first. If the client doesn't show it connected (some clients
won't load a brand-new server without a restart), fall back to a full restart and
do the **context handoff** below first. Plugin installs always prefer
`/reload-plugins`.

## Direct-MCP path — try `/mcp` reconnect first

1. Tell the user to open **`/mcp`** and **reconnect** the `chrome-devtools` server. This reloads it from the current registration (the pinned `--browserUrl`) in the same session — no context loss.
2. Run **`pdl_check_setup`** to confirm it's now registered + pinned at the active port, then **`pdl_launch_browser`** and a `chrome-devtools` tool (e.g. `list_pages`) to confirm it attached to *your* browser (not a fresh blank one).
3. If `/mcp` reconnect doesn't make the tools available, fall back to a **full restart** — do the context handoff below first.

## Full-restart fallback — do the handoff FIRST

Before telling the user to restart, **compose a short context-handoff note** and
present it for them to copy. This matters because most users are *not* running a
persistent-memory MCP, so restarting Claude Code wipes this conversation's
context. The note lets them paste the thread back into the fresh session.

Keep it tight — what we're doing, where we are, the immediate next step, and any
volatile state (ports, ids, branch). Template:

```
Context resume (pwa-debug + chrome-devtools):
- Goal: <one line — what we're building/debugging>
- Just did: registered chrome-devtools-mcp at http://127.0.0.1:<port> (direct MCP) and restarted.
- Next: <the immediate next action, e.g. "run pdl_check_setup, then pdl_launch_browser and verify chrome-devtools attached">
- State: branch <branch>, launch.defaultPort <port>, extension id <id if known>.
- Files in flight: <paths if mid-edit>.
```

Then give the restart steps:

1. **Restart Claude Code** (fully quit and relaunch — required to load the new direct MCP).
2. After restart, run **`/mcp`** to confirm `chrome-devtools` shows as connected.
3. Run **`pdl_check_setup`** to re-verify the whole chain (registration + port + extension).
4. Paste the context-resume note back so we continue where we left off.

## Plugin path (no restart)

1. Open **`/plugins`** and ensure the chrome-devtools plugin is enabled.
2. Run **`/reload-plugins`** to hot-load its MCP server in this same session.
3. Run **`/mcp`** to confirm it connected, then `pdl_check_setup`.

No context handoff is needed — the session is preserved.

## After tools are available

- Always `pdl_launch_browser` **before** any chrome-devtools tool call, so the
  browser + debug port exist for chrome-devtools to attach to.
- If `pdl_check_setup` flags an **unpinned** or **wrong-port** registration, re-run
  `pdl_register_chrome_devtools` (it removes + re-adds pinned at the active port),
  then reload/reconnect per the matrix above.
- Confirm coexistence with `list_pages` (chrome-devtools) — it should show the page
  pwa-debug is on. If it shows a blank/own browser, the registration is still
  unpinned or chrome-devtools wasn't reconnected.

## Getting the extension into the shared browser (brand matters)

`chrome-devtools-mcp` only needs the debug port; **pwa-debug** needs the extension
loaded in that same browser. How it gets there depends on the browser:

- **Non-Google Chromium (Brave, Chromium, Edge, Opera, Vivaldi) and Google Chrome ≤ 141** — `pdl_launch_browser` sandbox modes **preload** it via `--load-extension`. Nothing to do.
- **Branded Google Chrome ≥ 142** — `--load-extension` was removed, so the launch comes up **without** the extension (debug port still live for chrome-devtools). Relay the launch's `next_steps`: a one-time `chrome://extensions` → Developer mode → **Load unpacked** of the printed extension dir (persists in that dedicated profile), or just relaunch with `browser: "brave"` / `"chromium"`.

**Canonical both-tools profile:** `pdl_launch_browser({ browser: "brave", mode: "sandbox-persistent" })` → extension preloaded + debug port live + manifest auto-written, then pin chrome-devtools to that port. Verified live.

## Hard limits (state these plainly to the user)

- chrome-devtools-mcp is a separate server — a second registration is unavoidable
  without proxying, which this project deliberately does not do (no upstream
  version coupling).
- A registration change needs a (re)connect to take effect: `/mcp` reconnect
  (verified to pick up a changed `--browserUrl`) or `/reload-plugins` for a plugin
  install; a full restart is the fallback, not the default.
- The extension can't be force-loaded into branded Google Chrome 142+ from the CLI
  (the `--load-extension` removal is deliberate); a one-time manual *Load unpacked*
  or a non-Google Chromium is the only path there.
