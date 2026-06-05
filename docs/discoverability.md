# Discoverability checklist (M59)

Metadata that makes the project findable for the gaps it fills — service-worker /
cache / installability debugging + multi-framework introspection. The repo-local
metadata is **already in place**:

- `packages/host/package.json` — `keywords`, `description`, `repository`, `homepage`, `bugs`, `mcpName`
- root `package.json` — `description`, `keywords`, `repository`
- `server.json` — MCP Registry manifest (`io.github.aryanduntley/pwa-debug-layer`)

The steps below are **outward-facing** and intentionally left for you to run
(they publish to npm / GitHub / the MCP registry). `gh` auth was failing when
this was prepared — re-auth with `gh auth login` first.

## 1. GitHub repo description + topics

Replaces the AI-narrow framing with the pain-point + breadth framing.

```sh
gh repo edit aryanduntley/pwa-debug-layer \
  --description "AI-native debugging layer for PWAs: an AI agent (Claude Code via MCP) inspects live service workers, CacheStorage, IndexedDB, installability, and React/Vue/Svelte/Solid + Redux/Zustand/Pinia/Jotai state in your real logged-in browser. Why won't my SW update / why is my cache stale / why won't my PWA install — answered from the runtime." \
  --homepage "https://github.com/aryanduntley/pwa-debug-layer#readme"

gh repo edit aryanduntley/pwa-debug-layer \
  --add-topic pwa \
  --add-topic service-worker \
  --add-topic cache-storage \
  --add-topic indexeddb \
  --add-topic installability \
  --add-topic mcp \
  --add-topic model-context-protocol \
  --add-topic claude-code \
  --add-topic chrome-devtools \
  --add-topic ai-debugging \
  --add-topic react-devtools \
  --add-topic redux \
  --add-topic rrweb \
  --add-topic browser-automation \
  --add-topic diagnostics
```

## 2. npm publish

The packages are currently `private: true` / scope `@pwa-debug`. Before publishing:

1. Confirm (or create) the `@pwa-debug` npm org/scope you own.
2. In `packages/host/package.json` (the published artifact): set `"private": false`
   and pick a real license (add a `LICENSE` file + `"license"` field — root is
   currently `UNLICENSED`).
3. Confirm the `version` matches `server.json` (`0.1.0`) and bump together going forward.
4. Build + publish:

   ```sh
   pnpm -r build
   npm publish --workspace @aryanduntley/pwa-debug --access public
   ```

   `mcpName` in the package.json must equal the `server.json` `name` for the
   registry's npm-ownership check to pass.

## 3. MCP Registry submission

After the npm package is live, submit `server.json` to the official registry
(`registry.modelcontextprotocol.io`) with the MCP publisher CLI:

```sh
# https://github.com/modelcontextprotocol/registry — mcp-publisher
mcp-publisher login github
mcp-publisher publish   # reads ./server.json
```

The GitHub MCP Registry listing follows from the `io.github.aryanduntley/*`
namespace + the repo topics above.

## Keyword sources

npm `keywords` and GitHub topics deliberately lead with the **runtime-diagnostics**
terms the project is now uniquely strong on (service-worker, cache-storage,
indexeddb, installability, pwa-diagnostics) ahead of the framework/AI terms, so
searches for those real pains surface it.
