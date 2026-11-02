import type { CdpTarget } from '../cdp_client/discovery.js';
import { normalizeBrowserUrl } from '../cdp_client/discovery.js';
import type { CdpPageEndpoint } from '../transport/cdp_transport.js';
import type { TransportKind } from '../transport/types.js';

/** A pdl_launch_browser record with its debug port re-probed. */
export type LiveLaunch = {
  readonly browser: string;
  readonly profileType: string;
  readonly port: number;
  readonly browserUrl: string | null;
  readonly live: boolean;
};

export type SweepTargetClass =
  /** A phone page reached over adb; the endpoint is the page itself. */
  | { readonly ok: true; readonly kind: 'phone'; readonly endpoint: CdpPageEndpoint }
  /** A CDP connection to a page in a browser pwa-debug launched. */
  | { readonly ok: true; readonly kind: 'launched_cdp'; readonly endpoint: CdpPageEndpoint }
  /** An extension connection; its tab must be found on one of these launched debug ports. */
  | { readonly ok: true; readonly kind: 'launched_extension'; readonly browserUrls: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly next_steps: readonly string[] };

const RELAUNCH =
  "Launch a browser with pwa-debug so the host has its debug port: pdl_launch_browser({ profile: 'sandbox-persistent' }) (or 'sandbox-temp'), then run the sweep on that browser's extension connection.";
const PHONE =
  'Or sweep a phone: pdl_android_attach({ open_url }) and pass the returned connection id as extension_id.';

/** Debug endpoints of launches whose port answers, normalized for comparison. */
export const liveLaunchUrls = (launches: readonly LiveLaunch[]): readonly string[] => [
  ...new Set(
    launches
      .filter((l) => l.live)
      .map((l) => normalizeBrowserUrl(l.browserUrl ?? String(l.port)))
      .filter((u): u is string => u !== null),
  ),
];

/**
 * Decide whether a connection can be swept (spec §5). Phones (CDP over adb)
 * always can; desktop pages only inside a browser pwa-debug launched with a
 * live debug port. Everything else is refused with what to do instead.
 */
export const classifySweepTarget = (
  conn: { readonly kind: TransportKind; readonly extensionId: string },
  endpoint: CdpPageEndpoint | undefined,
  launches: readonly LiveLaunch[],
): SweepTargetClass => {
  const live = liveLaunchUrls(launches);
  if (conn.kind === 'cdp') {
    if (endpoint === undefined) {
      return {
        ok: false,
        error: `CDP connection ${conn.extensionId} is no longer attached`,
        next_steps: ['Call host_status for live connections, then attach again.'],
      };
    }
    if (endpoint.origin === 'android') return { ok: true, kind: 'phone', endpoint };
    const base = normalizeBrowserUrl(endpoint.baseUrl);
    if (base !== null && live.includes(base)) return { ok: true, kind: 'launched_cdp', endpoint };
    return {
      ok: false,
      error: `${conn.extensionId} is a desktop CDP connection to a browser pwa-debug did not launch; layout_sweep runs only on phones and on browsers started by pdl_launch_browser`,
      next_steps: [RELAUNCH, PHONE],
    };
  }
  if (live.length === 0) {
    const portless = launches.some((l) => l.live === false || l.browserUrl === null);
    return {
      ok: false,
      error:
        'this extension connection is not in a browser pwa-debug launched with a live debug port, so the viewport cannot be emulated',
      next_steps: [
        ...(portless
          ? [
              "A launch is recorded but its debug port is not answering. An 'existing'-profile launch on Chromium 136+ has no port (the default profile refuses --remote-debugging-port).",
            ]
          : []),
        RELAUNCH,
        PHONE,
      ],
    };
  }
  return { ok: true, kind: 'launched_extension', browserUrls: live };
};

export type LocateDeps = {
  /** Set window.__pdl_sweep_nonce in the connection's tab (through the extension bridge). */
  readonly stampNonce: (nonce: string) => Promise<void>;
  readonly clearNonce: () => Promise<void>;
  readonly listTargets: (browserUrl: string) => Promise<readonly CdpTarget[] | null>;
  /** True when the page behind this websocket carries the nonce. */
  readonly hasNonce: (webSocketDebuggerUrl: string, nonce: string) => Promise<boolean>;
};

export type LocateResult =
  | { readonly ok: true; readonly baseUrl: string; readonly target: CdpTarget }
  | { readonly ok: false; readonly error: string };

/**
 * Find the CDP page of an extension connection's tab: stamp a one-time nonce
 * through the bridge, then look for it in every page on the launched debug
 * ports. Exactly one match is the tab.
 */
export const locateTabByNonce = async (
  deps: LocateDeps,
  browserUrls: readonly string[],
  nonce: string,
): Promise<LocateResult> => {
  await deps.stampNonce(nonce);
  try {
    const perBrowser = await Promise.all(
      browserUrls.map(async (baseUrl) => {
        const targets = (await deps.listTargets(baseUrl)) ?? [];
        const flags = await Promise.all(
          targets.map((t) => deps.hasNonce(t.webSocketDebuggerUrl, nonce).catch(() => false)),
        );
        return targets.filter((_, i) => flags[i]).map((target) => ({ baseUrl, target }));
      }),
    );
    const matches = perBrowser.flat();
    const only = matches[0];
    if (matches.length === 1 && only !== undefined) return { ok: true, ...only };
    return {
      ok: false,
      error:
        matches.length === 0
          ? `the connection's tab was not found on any launched browser's debug port (${browserUrls.join(', ')}); this extension connection is probably in a browser pwa-debug did not launch`
          : `the connection's tab matched ${matches.length} pages; pass tab_id to pick one`,
    };
  } finally {
    await deps.clearNonce().catch(() => undefined);
  }
};
