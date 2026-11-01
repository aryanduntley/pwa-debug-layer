import { CDP_BRIDGE_VERSION, CDP_EMIT_BINDING, CDP_GLOBAL } from '@pwa-debug/shared';
import type { CdpClient } from '../cdp_client/types.js';
import type {
  IpcEventEnvelope,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
} from '../mcp/ipc/envelope.js';
import {
  buildDispatchExpression,
  capturesEnvelope,
  normalizeNavigateUrl,
  parseBindingEvent,
  parseDispatchResult,
  stripTabId,
} from './protocol.js';
import { EXTENSION_ONLY_TOOLS } from './support.js';

const DEFAULT_LOAD_TIMEOUT_MS = 10_000;
const MAX_LOAD_TIMEOUT_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** Reported as extensionVersion by session_ping on CDP connections. */
export const CDP_SESSION_VERSION_LABEL = `cdp-bridge/${CDP_BRIDGE_VERSION}`;

export type AttachSessionDeps = {
  readonly client: CdpClient;
  readonly bundleSource: string;
  readonly connectionId: string;
  readonly onEvent: (connectionId: string, env: IpcEventEnvelope) => void;
  /** Reload after registering the bundle, so it runs before the app's code. */
  readonly reload?: boolean;
  readonly loadTimeoutMs?: number;
};

export type CdpSession = {
  readonly connectionId: string;
  /** Bridge status read right after attach (shape owned by the bundle). */
  readonly status: unknown;
  readonly request: (
    env: IpcRequestEnvelope,
    opts?: { readonly timeoutMs?: number },
  ) => Promise<IpcResponseEnvelope>;
  readonly detach: () => Promise<void>;
  /** Re-read the bridge status (e.g. after a navigation). */
  readonly readStatus: () => Promise<unknown>;
};

const ok = (requestId: string, payload: unknown): IpcResponseEnvelope =>
  Object.freeze({ type: 'response', requestId, payload });

const fail = (requestId: string, message: string): IpcResponseEnvelope =>
  Object.freeze({ type: 'response', requestId, error: Object.freeze({ message }) });

const readNumber = (payload: unknown, key: string): number | undefined => {
  if (payload === null || typeof payload !== 'object') return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

/** Resolve on the next Page.loadEventFired, or 'timeout'. */
const waitForLoad = (client: CdpClient, timeoutMs: number): Promise<'complete' | 'loading'> =>
  new Promise((resolve) => {
    let off: () => void = () => undefined;
    const timer = setTimeout(() => {
      off();
      resolve('loading');
    }, timeoutMs);
    off = client.on('Page.loadEventFired', () => {
      clearTimeout(timer);
      off();
      resolve('complete');
    });
  });

const evaluateValue = async (client: CdpClient, expression: string): Promise<unknown> => {
  const r = (await client.send('Runtime.evaluate', { expression, returnByValue: true })) as {
    result?: { value?: unknown };
  };
  return r.result?.value;
};

/**
 * Attach to one page over an open client and install the bridge. Order
 * matters: the binding must exist before the bundle runs, and the
 * new-document script must be registered before any reload or navigation.
 */
export const attachSession = async (deps: AttachSessionDeps): Promise<CdpSession> => {
  const { client, connectionId } = deps;
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;

  await client.send('Runtime.enable');
  await client.send('Page.enable');
  // Inspector reports renderer crashes; a crashed tab answers nothing until it reloads.
  await client.send('Inspector.enable').catch(() => undefined);
  let crashed = false;
  const offCrash = client.on('Inspector.targetCrashed', () => {
    crashed = true;
  });
  const offRecovered = client.on('Page.loadEventFired', () => {
    crashed = false;
  });
  await client.send('Runtime.addBinding', { name: CDP_EMIT_BINDING });
  const added = (await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: deps.bundleSource,
  })) as { identifier?: string };

  const offBinding = client.on('Runtime.bindingCalled', (params) => {
    const event = parseBindingEvent(params);
    if (event !== null) deps.onEvent(connectionId, capturesEnvelope(connectionId, [event]));
  });

  if (deps.reload === true) {
    const loaded = waitForLoad(client, loadTimeoutMs);
    await client.send('Page.reload', { ignoreCache: false });
    await loaded;
  } else {
    await client.send('Runtime.evaluate', { expression: deps.bundleSource });
  }
  const readStatus = (): Promise<unknown> =>
    evaluateValue(client, `globalThis.${CDP_GLOBAL}?.status?.() ?? null`);
  const status = await readStatus();

  const forward = async (
    env: IpcRequestEnvelope,
    timeoutMs: number,
  ): Promise<IpcResponseEnvelope> => {
    const raw = await client.send(
      'Runtime.evaluate',
      {
        expression: buildDispatchExpression({
          requestId: env.requestId,
          tool: env.tool,
          ...(env.payload !== undefined ? { payload: stripTabId(env.payload) } : {}),
        }),
        awaitPromise: true,
        returnByValue: true,
      },
      { timeoutMs },
    );
    return parseDispatchResult(env.requestId, raw);
  };

  const sessionPing = async (env: IpcRequestEnvelope, timeoutMs: number) => {
    const page = await forward({ ...env, tool: 'session_ping', payload: undefined }, timeoutMs);
    return ok(env.requestId, {
      extensionVersion: CDP_SESSION_VERSION_LABEL,
      attachedTabId: null,
      pageWorld: page.error === undefined ? page.payload ?? null : null,
      ...(page.error !== undefined ? { pageWorldErrorMessage: page.error.message } : {}),
    });
  };

  const navigate = async (env: IpcRequestEnvelope) => {
    const payload = env.payload as Record<string, unknown> | undefined;
    const url = normalizeNavigateUrl(payload?.['url']);
    if (!url.ok) return fail(env.requestId, url.error);
    const waitMs = Math.min(readNumber(payload, 'timeout_ms') ?? loadTimeoutMs, MAX_LOAD_TIMEOUT_MS);
    const loaded = waitForLoad(client, waitMs);
    const nav = (await client.send('Page.navigate', { url: url.url })) as { errorText?: string };
    if (typeof nav.errorText === 'string' && nav.errorText !== '') {
      return fail(env.requestId, `pdl_navigate: ${nav.errorText} (${url.url})`);
    }
    return ok(env.requestId, { tabId: null, url: url.url, status: await loaded });
  };

  const request = async (
    env: IpcRequestEnvelope,
    opts?: { readonly timeoutMs?: number },
  ): Promise<IpcResponseEnvelope> => {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (crashed && env.tool !== 'pdl_navigate') {
      return fail(
        env.requestId,
        'the tab crashed (renderer gone). Reload it with pdl_navigate to its URL, or ask the user to reload it on the device; the connection recovers when the page loads.',
      );
    }
    try {
      switch (env.tool) {
        case 'session_ping':
          return await sessionPing(env, timeoutMs);
        case 'pdl_navigate':
          return await navigate(env);
        default:
          if (env.tool in EXTENSION_ONLY_TOOLS) return fail(env.requestId, EXTENSION_ONLY_TOOLS[env.tool]!);
          return await forward(env, timeoutMs);
      }
    } catch (err) {
      return fail(env.requestId, `cdp: ${env.tool} failed: ${(err as Error).message}`);
    }
  };

  const detach = async (): Promise<void> => {
    offBinding();
    offCrash();
    offRecovered();
    if (client.isOpen()) {
      // Best effort: leave the page as we found it for the next navigation.
      if (typeof added.identifier === 'string') {
        await client
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier })
          .catch(() => undefined);
      }
      await client.send('Runtime.removeBinding', { name: CDP_EMIT_BINDING }).catch(() => undefined);
    }
    client.close();
  };

  return Object.freeze({ connectionId, status, request, detach, readStatus });
};
