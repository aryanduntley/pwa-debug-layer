import type { CdpErrorKind } from './types.js';

const DEFAULT_HTTP_TIMEOUT_MS = 2_000;

/** An attachable page target from /json/list. */
export type CdpTarget = {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
};

/** Identity of a debug endpoint from /json/version. */
export type BrowserVersion = {
  readonly browser: string;
  readonly protocolVersion: string;
  readonly userAgent: string;
  readonly androidPackage?: string;
  readonly webSocketDebuggerUrl?: string;
};

export type DiscoveryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: CdpErrorKind; readonly message: string };

export type DiscoveryDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

const fail = <T>(kind: CdpErrorKind, message: string): DiscoveryResult<T> =>
  Object.freeze({ ok: false as const, kind, message });

const okv = <T>(value: T): DiscoveryResult<T> => Object.freeze({ ok: true as const, value });

/**
 * Accept '9222', '127.0.0.1:9222', 'http://host:port/...', 'ws://host:port/...'
 * and return 'http://host:port'. Null when no host/port can be read.
 */
export const normalizeBrowserUrl = (input: string): string | null => {
  const s = input.trim();
  if (s === '') return null;
  if (/^\d{1,5}$/.test(s)) return `http://127.0.0.1:${s}`;
  const withScheme = /^[a-z]+:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.hostname === '' || u.port === '') return null;
    return `http://${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
};

const getJson = async (
  url: string,
  deps?: DiscoveryDeps,
): Promise<DiscoveryResult<unknown>> => {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) return fail('http', `GET ${url} -> HTTP ${res.status}: ${text.slice(0, 120)}`);
    try {
      return okv(JSON.parse(text) as unknown);
    } catch {
      // Android Chrome answers some endpoints with plain text, e.g.
      // 'Could not create new page'.
      return fail('bad_body', `GET ${url} returned non-JSON: ${text.slice(0, 120)}`);
    }
  } catch (err) {
    return controller.signal.aborted
      ? fail('timeout', `GET ${url} timed out after ${timeoutMs}ms`)
      : fail('connect_failed', `GET ${url} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
};

const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === 'string' ? (o[k] as string) : undefined;

/** GET /json/version: browser identity plus the browser-level socket URL. */
export const fetchBrowserVersion = async (
  baseUrl: string,
  deps?: DiscoveryDeps,
): Promise<DiscoveryResult<BrowserVersion>> => {
  const r = await getJson(`${baseUrl}/json/version`, deps);
  if (!r.ok) return r;
  if (r.value === null || typeof r.value !== 'object') {
    return fail('bad_body', `${baseUrl}/json/version is not an object`);
  }
  const o = r.value as Record<string, unknown>;
  const androidPackage = str(o, 'Android-Package');
  const ws = str(o, 'webSocketDebuggerUrl');
  return okv(
    Object.freeze({
      browser: str(o, 'Browser') ?? 'unknown',
      protocolVersion: str(o, 'Protocol-Version') ?? 'unknown',
      userAgent: str(o, 'User-Agent') ?? '',
      ...(androidPackage !== undefined ? { androidPackage } : {}),
      ...(ws !== undefined ? { webSocketDebuggerUrl: ws } : {}),
    }),
  );
};

/** GET /json/list: page targets that can be attached to. */
export const listPageTargets = async (
  baseUrl: string,
  deps?: DiscoveryDeps,
): Promise<DiscoveryResult<readonly CdpTarget[]>> => {
  const r = await getJson(`${baseUrl}/json/list`, deps);
  if (!r.ok) return r;
  if (!Array.isArray(r.value)) return fail('bad_body', `${baseUrl}/json/list is not an array`);
  const targets = r.value.flatMap((raw): CdpTarget[] => {
    if (raw === null || typeof raw !== 'object') return [];
    const o = raw as Record<string, unknown>;
    const id = str(o, 'id');
    const ws = str(o, 'webSocketDebuggerUrl');
    if (str(o, 'type') !== 'page' || id === undefined || ws === undefined) return [];
    return [
      Object.freeze({
        id,
        type: 'page',
        title: str(o, 'title') ?? '',
        url: str(o, 'url') ?? '',
        webSocketDebuggerUrl: ws,
      }),
    ];
  });
  return okv(Object.freeze(targets));
};
