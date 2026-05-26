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
- When `pdl_check_setup` reports chrome-devtools-mcp as not registered / wrong port.

## The one rule that drives everything

**A newly added MCP server only loads when Claude Code (re)connects it.** How you
trigger that depends entirely on the install mode. `/mcp` does **not** load a
newly-added server — it only shows status and retries already-known connections.

| Install mode | How chrome-devtools tools become available | Full restart? | Context lost? |
| --- | --- | --- | --- |
| **Direct MCP** (`claude mcp add …`) | **Restart Claude Code** | **Yes** | **Yes** — see handoff below |
| **Plugin** (bundled MCP server) | Enable in `/plugins`, then run **`/reload-plugins`** | **No** (same session) | No |

So: if chrome-devtools-mcp was installed as a **plugin**, prefer `/reload-plugins`
— it hot-loads the server with no restart and no context loss. If it was added as
a **direct MCP** (what `pdl_register_chrome_devtools` writes), a full restart is
unavoidable, so do the **context handoff** first.

## Direct-MCP path (restart required) — do the handoff FIRST

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
- If `pdl_check_setup` flags a **wrong-port** registration, re-run
  `pdl_register_chrome_devtools` (it removes + re-adds at the active port), then
  reload/restart per the matrix above.

## Hard limits (state these plainly to the user)

- chrome-devtools-mcp is a separate server — a second registration is unavoidable
  without proxying, which this project deliberately does not do (no upstream
  version coupling).
- A direct-MCP registration change requires a full restart; only the plugin path
  avoids it.
