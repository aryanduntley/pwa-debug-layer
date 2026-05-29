# popup-pwa fixture

Standalone, build-free smoke target for pwa-debug **Path 6** (`library_popup`
capture). A single static `index.html` with no dependencies — open it directly
in a pwa-debug managed browser. NOT part of the pnpm workspace.

## Scenarios (locked for assertions)

| Button | Detection path | Expected `popup_tail` event |
| --- | --- | --- |
| Open shadow modal | `<w3m-modal>` attaches an **open shadow root after load** | `{ phase:'appeared', detection:'shadow', library:'walletconnect' }` |
| Open light-DOM portal modal | high-z-index `position:fixed` node appended to `<body>` | `{ phase:'appeared', detection:'portal', library:'unknown' }` |
| Simulate connect failure | renders an in-modal `role=alert` on the portal modal + `console.error` + failing `fetch` | no new detection event; `popup_failures` correlates the alert text, console error, and failed fetch against the open portal popup |

Closing either modal removes its host node and emits a matching
`{ phase:'disappeared' }` with the same `popupId`.

## Why static HTML

The producer + `popup_tail` tool are covered by deterministic unit tests
(`packages/extension/test/captures/capture_popup.test.ts`,
`packages/host/test/mcp/tools/popup_tail.test.ts`). This fixture is the **manual
/ live** smoke target. CI-integrated fixture automation, signature tuning, and
the crypto-PWA live pass are **M-D**.

## Run

Serve the folder (any static server) and open it, e.g.:

```sh
npx serve examples/popup-pwa
# or
python3 -m http.server --directory examples/popup-pwa
```

## Live-verify runbook (D1)

This is the repeatable end-to-end check that the `library_popup` pipeline works
**wire-to-wire** through the real extension + host stack (the integration the
unit tests stub out). All steps run through the `pwa-debug` MCP tools; no human
clicking required. Last run: **all green** (see "Observed result" below).

### Driving model (read first)

**pwa-debug is the driver; chrome-devtools-mcp is a complementary tool surface.**
pwa-debug is coded to talk directly to the extension (page-bridge into the MAIN
world), so anything that touches extension capture or page state is driven
through pwa-debug. chrome-devtools-mcp is there only for the primitives we
deliberately don't reinvent (tracing, Lighthouse, heap snapshots) — it is *not*
the driver here.

This matters because the two operate in different browser contexts:

- **`chrome-devtools-mcp` opens its tabs in an isolated browser context where
  MV3 extensions do NOT run.** A fixture opened/navigated via
  `mcp__chrome-devtools__navigate_page` produces **zero** capture events — the
  content script never injects there. That's expected: driving the extension was
  never CDP's role. Confirm with `recent_events` — if every event's `frameUrl`
  is some *other* tab, the fixture tab has no page-world.
- **Drive the fixture through pwa-debug `evaluate`** in a normal-context,
  extension-loaded tab (runs in MAIN world via the page-bridge — a real click
  through the real producer). Either open the fixture in a normal tab, or
  navigate the active normal-context tab to it with
  `evaluate("window.location.assign('http://localhost:8099/index.html')")`.
- Confirm page-world is live on the fixture with `session_ping` — its
  `pageWorld.url` must be the fixture URL.

> Note: `pdl_launch_browser mode=sandbox-persistent` restores the profile's
> previous tabs. A leftover tab (e.g. the react-pwa fixture on `:5173`) can be
> the active/extension-enabled tab; navigating *it* to the fixture is the
> simplest way to land in a capture-enabled context.

### Steps

Serve the fixture (`python3 -m http.server 8099 --directory examples/popup-pwa`)
and make it the active normal-context tab (see gotcha). Then:

1. **Baseline** — `popup_tail` → expect `entries: []`.
2. **Shadow appeared** — `evaluate("document.getElementById('open-shadow').click()")`,
   then `popup_tail`. Expect two entries with one stable `popupId`:
   `{ phase:'appeared', detection:'shadow', library:'walletconnect', host.tagName:'W3M-MODAL' }`
   then a `phase:'updated'` carrying `state.text` + `buttons:[{label:'Close'}]`.
3. **Shadow disappeared** —
   `evaluate("document.querySelector('w3m-modal').shadowRoot.getElementById('close').click()")`,
   then `popup_tail` with `filter.since=<cursor>`. Expect `{ phase:'disappeared' }`,
   same `popupId`.
4. **Portal appeared** — `evaluate("document.getElementById('open-portal').click()")`,
   then `popup_tail`. Expect
   `{ phase:'appeared', detection:'portal', library:'unknown', host.tagName:'DIV' }`.
5. **Portal disappeared** —
   `evaluate("document.querySelector('[data-portal-modal]').querySelector('#close-portal').click()")`,
   then `popup_tail` (`filter.since`). Expect `{ phase:'disappeared' }`, same `popupId`.
6. **Failure correlation** — open the portal first (step 4) so the popup window
   is already open, **then**
   `evaluate("document.getElementById('simulate-failure').click()")`, then
   `popup_failures`. Expect one report:
   - `reason` / `alerts`: `"Connection failed: user rejected the request."` (the `role=alert`)
   - `console`: the `error` "[popup-pwa] wallet connect failed: user rejected request"
   - `network`: the failed `fetch` to `https://invalid.example.invalid/connect` (`phase:'error'`)

   **Ordering matters.** The `simulate-failure` button auto-opens the portal if
   it is closed, but in that path the synchronous `console.error` is timestamped
   a hair *before* the popup's `appeared` ts (which the MutationObserver stamps
   on the next microtask), so it falls just outside the correlation window and
   the `console[]` array comes back empty (the alert + fetch still correlate).
   Trigger the failure on an **already-open** popup and the console error lands
   inside the window and correlates deterministically. Real widgets fail *after*
   opening, so this only affects the fixture's same-tick path.

### Observed result (last green run)

- Shadow: `appeared`→`updated`→`disappeared`, one `popupId`, `library:'walletconnect'`.
- Portal: `appeared`→`disappeared`, one `popupId`, `library:'unknown'`.
- Failure (on open popup): `popup_failures` report with the alert text as
  `reason`, the correlated `console` error, and the failed `fetch` — all matched
  to the portal `popupId` by `frameKey` within the open window.
