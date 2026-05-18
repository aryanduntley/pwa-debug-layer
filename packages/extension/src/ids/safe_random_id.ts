// Single source of truth for opaque correlation-id generation.
//
// crypto.randomUUID() is unavailable on insecure origins (e.g.
// http://<LAN-IP> debug targets) and old runtimes — a real pwa-debug use
// case. Every id generator must therefore guard the call; this collapses
// the four hand-rolled guards (capture_fetch/xhr/websocket defaultIdGen +
// frame_meta cross-origin fallback) and the one UNGUARDED site
// (cs_dispatcher's default generateRequestId, which threw on such origins).

const cryptoRandomUUID = (): string | undefined => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof c?.randomUUID === 'function' ? c.randomUUID() : undefined;
};

const fallback = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

// crypto.randomUUID() when available, else `${fallbackPrefix}<ts36>_<rand36>`.
// fallbackPrefix namespaces ONLY the fallback path, exactly preserving the
// prior per-producer f_/x_/w_ discriminators.
export const safeRandomId = (fallbackPrefix = ''): string =>
  cryptoRandomUUID() ?? fallback(fallbackPrefix);

// No-prefix convenience: the crypto-absent-safe replacement for a bare
// `crypto.randomUUID()` call.
export const safeUuid = (): string => safeRandomId();
