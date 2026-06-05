# Live verification — T2/T3 diagnostics tools (M64–M66)

The four tools below are unit-tested with fakes only. This is the real-browser
round-trip. **Prereqs (one-time after the build):**

1. `pnpm -r build` (host + extension already built this session).
2. Reload the MCP server so it serves the new tools:
   - `/reload-plugins` (if installed via the M48 plugin), **or** restart Claude Code.
3. Get the extension + a live debug-port browser up:
   - `pdl_launch_browser` (sandbox-persistent on Brave native = the known PASS target), **or**
   - reload the unpacked extension at `brave://extensions`, then `host_register_extension`.
4. `host_status` → confirm `activeConnections` is non-empty.
5. Navigate the tab to a PWA that actually uses SW + Cache + IndexedDB (a real
   installed PWA, or an example served over http). Web storage / IDB / caches are
   per-origin, so pick a page that populates them.

## 1. storage_get (M64)
- `storage_get { area: "local" }` → `{ supported, area, entries:[{key,value,truncated?}], entryCount, truncated }`.
- `storage_get { area: "session" }` → area echoes `session`.
- Expect real keys from the page; long values flagged `truncated:true`.

## 2. idb_list (M64)
- `idb_list` → `{ supported, databases:[{ name, version, stores:[{name,keyPath,autoIncrement,indexes:[{name,keyPath,unique,multiEntry}]}], error? }] }`.
- Check: db names match what the app uses; opening them did **not** create empty DBs
  (re-run `idb_list`, count unchanged).

## 3. idb_query (M64)
- `idb_query { db: "<from idb_list>", store: "<from idb_list>", limit: 5 }`
  → `{ supported, found:true, records:[{key,value,truncated?}], returned, truncated }`.
- Truncation: set `limit` below the store's record count → `truncated:true`, `returned == limit`.
- Negative: `idb_query { db:"nope", store:"x" }` → `found:false`, no throw.

## 4. pwa_update_analyze (M65)
- Baseline: `pwa_update_analyze` on a healthy page → `findings: []`, summary "no issues".
- Waiting-SW path: deploy a SW update (or use a page mid-update) so a worker is
  `waiting` while the page stays controlled → finding `waiting_update_active_client`.
- Skew path: a page whose cached HTML is much older than cached JS → `html_older_js`.
- 404 path: trigger a JS/CSS request that 404s (it lands in the network buffer) →
  `chunk_404` with the URL listed.

## 5. pwa_snapshot (M66)
- `pwa_snapshot` → `{ url, title, capturedAt, sw, store, webStorage:{local,session}, idb, cacheNames }`.
- `store` is non-null only if a Redux/Pinia/Jotai/Zustand store auto-detects
  (examples/react-pwa is RTK → expect `framework:"redux"`).
- Cross-check: `pwa_snapshot.idb` db names == `idb_list` output; `webStorage.local` == `storage_get`.

## Known gotchas (from prior live sessions)
- Chrome 137+ ignores `--load-extension`; **Brave native is the PASS target**.
- Sandbox-persistent caches the extension — set `PWA_DEBUG_REFRESH_EXTENSION` to force
  `chrome.runtime.reload()` so a rebuild's new tools/handlers are served (else
  "unknown tool: idb_list" etc.).
- chrome-devtools-mcp must be pinned `--browserUrl http://127.0.0.1:<launch port>`.
