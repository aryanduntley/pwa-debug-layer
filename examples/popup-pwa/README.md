# popup-pwa fixture

Standalone, build-free smoke target for pwa-debug **Path 6** (`library_popup`
capture). A single static `index.html` with no dependencies — open it directly
in a pwa-debug managed browser. NOT part of the pnpm workspace.

## Scenarios (locked for assertions)

| Button | Detection path | Expected `popup_tail` event |
| --- | --- | --- |
| Open shadow modal | `<w3m-modal>` attaches an **open shadow root after load** | `{ phase:'appeared', detection:'shadow', library:'walletconnect' }` |
| Open light-DOM portal modal | high-z-index `position:fixed` node appended to `<body>` | `{ phase:'appeared', detection:'portal', library:'unknown' }` |
| Simulate connect failure | `console.error` + failing `fetch` | (no popup; correlated failure surfacing is M-C) |

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
