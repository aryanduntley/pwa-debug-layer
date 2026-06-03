/**
 * Pure CDP-target selection for the persistent-profile extension auto-refresh.
 *
 * A sandbox-persistent profile caches the unpacked extension and serves STALE
 * page-world/SW code on relaunch — newly added pdl_* tools report "unknown tool"
 * even though the on-disk bundle is current (note 318). The fix is to force
 * chrome.runtime.reload() in the extension's MV3 service worker over CDP, which
 * makes it re-read the source dir. To do that we need the SW's
 * webSocketDebuggerUrl from the browser's /json/list — the pure pick lives here;
 * the websocket effect lives at the edge (node_deps.refreshExtensionImpl).
 */

/** A loaded MV3 extension surfaces its service worker as a chrome-extension:// target. */
const EXTENSION_SW_URL_RE = /^chrome-extension:\/\//;

/**
 * The webSocketDebuggerUrl of the first loaded-extension service-worker target in
 * a CDP /json/list body, or null when none is present (port not up yet, or the
 * extension's SW hasn't started). Tolerant of arbitrary/malformed entries — only
 * an object with type==='service_worker', a chrome-extension:// url, and a string
 * webSocketDebuggerUrl qualifies.
 */
export const extensionSwWsUrl = (
  targets: readonly unknown[],
): string | null => {
  for (const t of targets) {
    if (t === null || typeof t !== 'object') continue;
    const o = t as {
      type?: unknown;
      url?: unknown;
      webSocketDebuggerUrl?: unknown;
    };
    if (
      o.type === 'service_worker' &&
      typeof o.url === 'string' &&
      EXTENSION_SW_URL_RE.test(o.url) &&
      typeof o.webSocketDebuggerUrl === 'string'
    ) {
      return o.webSocketDebuggerUrl;
    }
  }
  return null;
};
