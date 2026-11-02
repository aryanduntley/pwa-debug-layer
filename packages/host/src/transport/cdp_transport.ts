import { connectCdp } from '../cdp_client/client.js';
import {
  fetchBrowserVersion,
  listPageTargets,
  normalizeBrowserUrl,
  type BrowserVersion,
  type CdpTarget,
} from '../cdp_client/discovery.js';
import type { IpcEventEnvelope, IpcRequestEnvelope, IpcResponseEnvelope } from '../mcp/ipc/envelope.js';
import type { IpcSendResult } from '../mcp/ipc/ipc_server.js';
import { attachSession, type CdpSession } from '../cdp_session/session.js';
import { cdpConnectionId, normalizeNavigateUrl } from '../cdp_session/protocol.js';
import type { Transport, TransportConnectionInfo } from './types.js';
import type { HostCapturedEvent } from '../captures_in/captures_in.js';

const NEW_TARGET_POLL_MS = 150;
const NEW_TARGET_WAIT_MS = 4_000;

export type CdpTransportDeps = {
  readonly onEvent: (connectionId: string, env: IpcEventEnvelope) => void;
  /** Source of page-world-cdp.js. */
  readonly loadBundle: () => Promise<string>;
  readonly connect?: typeof connectCdp;
  /** Capture gate (same rules as the extension SW); events failing it are dropped. */
  readonly shouldCapture?: (event: HostCapturedEvent) => boolean;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
};

export type CdpAttachOptions = {
  /** Debug endpoint: '9222', 'host:port' or an http/ws URL. */
  readonly browserUrl: string;
  readonly targetId?: string;
  /** Pick the page whose URL contains this text. */
  readonly urlContains?: string;
  /** Reload after attaching so the bridge runs before the app's own code. */
  readonly reload?: boolean;
  /** Who reached this endpoint: the adb bridge ('android') or a desktop debug port (default). */
  readonly origin?: CdpOrigin;
};

/** How a CDP connection was reached; the layout sweep accepts phones only through 'android'. */
export type CdpOrigin = 'android' | 'desktop';

/** Where an attached connection's page lives, for callers that open their own CDP client on it. */
export type CdpPageEndpoint = {
  readonly connectionId: string;
  readonly baseUrl: string;
  readonly targetId: string;
  readonly webSocketDebuggerUrl: string;
  readonly url: string;
  readonly origin: CdpOrigin;
};

export type CdpAttachResult =
  | {
      readonly ok: true;
      readonly connectionId: string;
      readonly target: CdpTarget;
      readonly status: unknown;
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly candidates?: readonly CdpTarget[] };

export type CdpTargetsResult =
  | {
      readonly ok: true;
      readonly browserUrl: string;
      readonly version: BrowserVersion;
      readonly targets: readonly (CdpTarget & { readonly connectionId: string; readonly attached: boolean })[];
    }
  | { readonly ok: false; readonly error: string };

export type CdpOpenTabOptions = {
  readonly browserUrl: string;
  /** Validated with the shared navigation URL rules. */
  readonly url: unknown;
  readonly timeoutMs?: number;
  readonly origin?: CdpOrigin;
};

export type CdpOpenTabResult =
  | (Extract<CdpAttachResult, { ok: true }> & { readonly url: string; readonly loadStatus: 'complete' | 'loading' })
  | { readonly ok: false; readonly error: string };

export type CdpTransport = Transport & {
  readonly attach: (opts: CdpAttachOptions) => Promise<CdpAttachResult>;
  readonly openTab: (opts: CdpOpenTabOptions) => Promise<CdpOpenTabResult>;
  readonly detach: (connectionId: string) => Promise<boolean>;
  readonly targets: (browserUrl: string) => Promise<CdpTargetsResult>;
  /** The page endpoint behind an attached connection, or undefined when it is not (or no longer) attached. */
  readonly pageEndpoint: (connectionId: string) => CdpPageEndpoint | undefined;
};

type Entry = {
  readonly session: CdpSession;
  /** Kept current from top-frame navigations so labels do not go stale. */
  target: CdpTarget;
  readonly baseUrl: string;
  readonly origin: CdpOrigin;
  readonly connectedAt: number;
  lastSeenAt: number;
};

const isUserPage = (t: CdpTarget): boolean =>
  !/^(chrome|chrome-native|devtools|chrome-extension|about):/i.test(t.url);

/** Pick one target from a list, or explain why none or several match. */
const pickTarget = (
  targets: readonly CdpTarget[],
  opts: CdpAttachOptions,
): { readonly ok: true; readonly target: CdpTarget } | { readonly ok: false; readonly error: string } => {
  if (opts.targetId !== undefined) {
    const t = targets.find((x) => x.id === opts.targetId || x.id.startsWith(opts.targetId!));
    return t !== undefined ? { ok: true, target: t } : { ok: false, error: `no page target with id ${opts.targetId}` };
  }
  const pool =
    opts.urlContains !== undefined
      ? targets.filter((t) => t.url.includes(opts.urlContains!))
      : targets.filter(isUserPage);
  if (pool.length === 1) return { ok: true, target: pool[0]! };
  if (pool.length === 0) {
    return {
      ok: false,
      error:
        opts.urlContains !== undefined
          ? `no page target whose URL contains "${opts.urlContains}"`
          : 'no regular web page is open on that endpoint (only browser-internal pages)',
    };
  }
  return { ok: false, error: `${pool.length} page targets match; pass target_id or url_contains` };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The 'cdp' transport: one entry per attached page. Sessions are dropped as
 * soon as their socket closes (tab closed, browser quit, adb unplugged).
 */
export const createCdpTransport = (deps: CdpTransportDeps): CdpTransport => {
  const connect = deps.connect ?? connectCdp;
  const now = deps.now ?? Date.now;
  const discovery = deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : undefined;
  const entries = new Map<string, Entry>();

  const listConnections = (): readonly TransportConnectionInfo[] =>
    [...entries.entries()].map(([id, e]) =>
      Object.freeze({
        extensionId: id,
        kind: 'cdp' as const,
        connectedAt: e.connectedAt,
        lastSeenAt: e.lastSeenAt,
        label: e.target.title !== '' ? `${e.target.title} (${e.target.url})` : e.target.url,
      }),
    );

  const attachTarget = async (
    baseUrl: string,
    target: CdpTarget,
    reload: boolean,
    origin: CdpOrigin,
  ): Promise<CdpAttachResult> => {
    const connectionId = cdpConnectionId(baseUrl, target.id);
    const existing = entries.get(connectionId);
    if (existing !== undefined) {
      return { ok: true, connectionId, target: existing.target, status: existing.session.status, reused: true };
    }
    const bundleSource = await deps.loadBundle();
    const client = await connect(target.webSocketDebuggerUrl);
    let session: CdpSession;
    try {
      session = await attachSession({
        client,
        bundleSource,
        connectionId,
        reload,
        onEvent: (id, env) => {
          const e = entries.get(id);
          if (e !== undefined) e.lastSeenAt = now();
          const payload = env.payload as { readonly events?: readonly HostCapturedEvent[] } | undefined;
          const events = (payload?.events ?? []).filter((ev) => deps.shouldCapture?.(ev) ?? true);
          if (events.length > 0) deps.onEvent(id, { ...env, payload: { events } });
        },
      });
    } catch (err) {
      client.close();
      return { ok: false, error: `attach to ${target.url} failed: ${(err as Error).message}` };
    }
    const t = now();
    entries.set(connectionId, { session, target, baseUrl, origin, connectedAt: t, lastSeenAt: t });
    client.onClose(() => {
      entries.delete(connectionId);
    });
    client.on('Page.frameNavigated', (params) => {
      const frame = (params as { frame?: { parentId?: string; url?: string } } | undefined)?.frame;
      const e = entries.get(connectionId);
      if (e === undefined || frame === undefined || frame.parentId !== undefined || typeof frame.url !== 'string') return;
      // The title belongs to the previous document; drop it rather than mislabel.
      e.target = { ...e.target, url: frame.url, title: '' };
    });
    return { ok: true, connectionId, target, status: session.status, reused: false };
  };

  const attach = async (opts: CdpAttachOptions): Promise<CdpAttachResult> => {
    const baseUrl = normalizeBrowserUrl(opts.browserUrl);
    if (baseUrl === null) return { ok: false, error: `cannot read a host:port from "${opts.browserUrl}"` };
    const listed = await listPageTargets(baseUrl, discovery);
    if (!listed.ok) return { ok: false, error: `cannot list pages at ${baseUrl}: ${listed.message}` };
    const picked = pickTarget(listed.value, opts);
    if (!picked.ok) return { ok: false, error: picked.error, candidates: listed.value };
    return attachTarget(baseUrl, picked.target, opts.reload === true, opts.origin ?? 'desktop');
  };

  const detach = async (connectionId: string): Promise<boolean> => {
    const e = entries.get(connectionId);
    if (e === undefined) return false;
    entries.delete(connectionId);
    await e.session.detach();
    return true;
  };

  const targets = async (browserUrl: string): Promise<CdpTargetsResult> => {
    const baseUrl = normalizeBrowserUrl(browserUrl);
    if (baseUrl === null) return { ok: false, error: `cannot read a host:port from "${browserUrl}"` };
    const version = await fetchBrowserVersion(baseUrl, discovery);
    if (!version.ok) return { ok: false, error: `no debug endpoint at ${baseUrl}: ${version.message}` };
    const listed = await listPageTargets(baseUrl, discovery);
    if (!listed.ok) return { ok: false, error: `cannot list pages at ${baseUrl}: ${listed.message}` };
    return {
      ok: true,
      browserUrl: baseUrl,
      version: version.value,
      targets: listed.value.map((t) => {
        const connectionId = cdpConnectionId(baseUrl, t.id);
        return { ...t, connectionId, attached: entries.has(connectionId) };
      }),
    };
  };

  /**
   * Open a tab on an endpoint and attach it. The tab starts blank so the
   * bridge is registered before the real page's first script runs, then it
   * navigates to the URL.
   */
  const openTab = async (opts: CdpOpenTabOptions): Promise<CdpOpenTabResult> => {
    const baseUrl = normalizeBrowserUrl(opts.browserUrl);
    if (baseUrl === null) return { ok: false, error: `cannot read a host:port from "${opts.browserUrl}"` };
    const url = normalizeNavigateUrl(opts.url);
    if (!url.ok) return { ok: false, error: url.error.replace('pdl_navigate', 'open tab') };
    const version = await fetchBrowserVersion(baseUrl, discovery);
    if (!version.ok || version.value.webSocketDebuggerUrl === undefined) {
      return { ok: false, error: `no browser socket at ${baseUrl}` };
    }
    const browser = await connect(version.value.webSocketDebuggerUrl);
    let targetId: string;
    try {
      const created = (await browser.send('Target.createTarget', { url: 'about:blank' })) as { targetId?: string };
      if (typeof created.targetId !== 'string') return { ok: false, error: 'Target.createTarget returned no targetId' };
      targetId = created.targetId;
    } finally {
      browser.close();
    }
    const deadline = now() + NEW_TARGET_WAIT_MS;
    let target: CdpTarget | undefined;
    while (target === undefined && now() < deadline) {
      const listed = await listPageTargets(baseUrl, discovery);
      target = listed.ok ? listed.value.find((t) => t.id === targetId) : undefined;
      if (target === undefined) await sleep(NEW_TARGET_POLL_MS);
    }
    if (target === undefined) return { ok: false, error: `new tab ${targetId} never appeared in /json/list` };
    const attached = await attachTarget(baseUrl, target, false, opts.origin ?? 'desktop');
    if (!attached.ok) return attached;
    const e = entries.get(attached.connectionId)!;
    const nav = await e.session.request({
      type: 'request',
      requestId: `open-tab-${attached.connectionId}`,
      tool: 'pdl_navigate',
      payload: { url: url.url, ...(opts.timeoutMs !== undefined ? { timeout_ms: opts.timeoutMs } : {}) },
    });
    if (nav.error !== undefined) return { ok: false, error: nav.error.message };
    const status = (nav.payload as { status?: 'complete' | 'loading' } | undefined)?.status ?? 'loading';
    // The status read at attach describes about:blank; report the real page's.
    const bridge = await e.session.readStatus().catch(() => attached.status);
    return { ...attached, status: bridge, target: { ...attached.target, url: url.url }, url: url.url, loadStatus: status };
  };

  const newTab = async (from: Entry, env: IpcRequestEnvelope): Promise<IpcResponseEnvelope> => {
    const payload = env.payload as Record<string, unknown> | undefined;
    const timeout = payload?.['timeout_ms'];
    const r = await openTab({
      browserUrl: from.baseUrl,
      origin: from.origin,
      url: payload?.['url'],
      ...(typeof timeout === 'number' ? { timeoutMs: timeout } : {}),
    });
    if (!r.ok) return { type: 'response', requestId: env.requestId, error: { message: `pdl_new_tab: ${r.error}` } };
    return {
      type: 'response',
      requestId: env.requestId,
      payload: { tabId: null, url: r.url, status: r.loadStatus, created: true, connectionId: r.connectionId },
    };
  };

  const request = async (
    id: string,
    env: IpcRequestEnvelope,
    opts?: { readonly timeoutMs?: number },
  ): Promise<IpcResponseEnvelope> => {
    const e = entries.get(id);
    if (e === undefined) throw new Error(`no connected NMH for ${id}`);
    e.lastSeenAt = now();
    return env.tool === 'pdl_new_tab' ? newTab(e, env) : e.session.request(env, opts);
  };

  // Settings pushes target the extension's settings cache; a CDP page has
  // none yet (capture gating for CDP connections is host-side, later).
  const sendTo = (id: string): IpcSendResult =>
    entries.has(id) ? { ok: true } : { ok: false, error: `no connected NMH for ${id}` };

  const pageEndpoint = (connectionId: string): CdpPageEndpoint | undefined => {
    const e = entries.get(connectionId);
    return e === undefined
      ? undefined
      : Object.freeze({
          connectionId,
          baseUrl: e.baseUrl,
          targetId: e.target.id,
          webSocketDebuggerUrl: e.target.webSocketDebuggerUrl,
          url: e.target.url,
          origin: e.origin,
        });
  };

  const close = async (): Promise<void> => {
    const all = [...entries.keys()];
    await Promise.all(all.map((id) => detach(id)));
  };

  return Object.freeze({ kind: 'cdp' as const, listConnections, request, sendTo, close, attach, openTab, detach, targets, pageEndpoint });
};
