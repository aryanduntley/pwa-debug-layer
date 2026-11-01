import {
  cdpError,
  type CdpClient,
  type CdpClientOptions,
  type CdpEventHandler,
  type CdpSendOptions,
  type WebSocketCtor,
  type WebSocketLike,
} from './types.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const WS_OPEN = 1;

type Pending = {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type InboundMessage = {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly sessionId?: string;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: string };
};

const parseMessage = (data: unknown): InboundMessage | null => {
  if (typeof data !== 'string') return null;
  try {
    const v = JSON.parse(data) as unknown;
    return v !== null && typeof v === 'object' ? (v as InboundMessage) : null;
  } catch {
    return null;
  }
};

const resolveCtor = (opts?: CdpClientOptions): WebSocketCtor | null =>
  opts?.WebSocketImpl ??
  ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined) ??
  null;

const openSocket = (
  Ctor: WebSocketCtor,
  wsUrl: string,
  timeoutMs: number,
): Promise<WebSocketLike> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocketLike;
    try {
      ws = new Ctor(wsUrl);
    } catch (err) {
      reject(cdpError('connect_failed', `cdp: cannot open ${wsUrl}: ${(err as Error).message}`));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(cdpError('timeout', `cdp: connect to ${wsUrl} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cdpError('connect_failed', `cdp: could not connect to ${wsUrl}`));
    };
    ws.addEventListener('error', fail);
    ws.addEventListener('close', fail);
  });

/**
 * Open a CDP WebSocket. Commands are matched to responses by id; events fan
 * out to every handler registered for their method. When the socket closes,
 * every pending command rejects with kind 'closed' and close handlers run once.
 */
export const connectCdp = async (
  wsUrl: string,
  opts?: CdpClientOptions,
): Promise<CdpClient> => {
  const Ctor = resolveCtor(opts);
  if (Ctor === null) {
    throw cdpError(
      'no_websocket',
      'cdp: no WebSocket implementation available. CDP connections need Node 22 or newer.',
    );
  }
  const ws = await openSocket(Ctor, wsUrl, opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  const defaultTimeoutMs = opts?.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  // Connection state lives in this closure: it is the socket's lifetime.
  let nextId = 1;
  let open = true;
  const pending = new Map<number, Pending>();
  const handlers = new Map<string, Set<CdpEventHandler>>();
  const closeHandlers = new Set<() => void>();

  const settleAllClosed = (): void => {
    if (!open) return;
    open = false;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(cdpError('closed', `cdp: socket closed before ${p.method} answered`));
      pending.delete(id);
    }
    for (const h of [...closeHandlers]) {
      try {
        h();
      } catch {
        /* a close handler must not break the others */
      }
    }
  };

  ws.addEventListener('message', (ev) => {
    const msg = parseMessage(ev.data);
    if (msg === null) return;
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (p === undefined) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        const detail = msg.error.data !== undefined ? ` (${msg.error.data})` : '';
        p.reject(
          cdpError('protocol', `cdp: ${p.method} failed: ${msg.error.message ?? 'unknown error'}${detail}`, msg.error.code),
        );
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const set = handlers.get(msg.method);
      if (set === undefined) return;
      for (const h of [...set]) {
        try {
          h(msg.params, msg.sessionId);
        } catch {
          /* one bad handler must not starve the rest */
        }
      }
    }
  });
  ws.addEventListener('close', settleAllClosed);
  ws.addEventListener('error', settleAllClosed);

  const send = (
    method: string,
    params?: Record<string, unknown>,
    sendOpts?: CdpSendOptions,
  ): Promise<unknown> => {
    if (!open || ws.readyState !== WS_OPEN) {
      return Promise.reject(cdpError('closed', `cdp: socket is closed; cannot send ${method}`));
    }
    const id = nextId++;
    const timeoutMs = sendOpts?.timeoutMs ?? defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(cdpError('timeout', `cdp: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try {
        ws.send(
          JSON.stringify({
            id,
            method,
            ...(params !== undefined ? { params } : {}),
            ...(sendOpts?.sessionId !== undefined ? { sessionId: sendOpts.sessionId } : {}),
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(cdpError('closed', `cdp: send ${method} failed: ${(err as Error).message}`));
      }
    });
  };

  const on = (method: string, handler: CdpEventHandler): (() => void) => {
    const set = handlers.get(method) ?? new Set<CdpEventHandler>();
    set.add(handler);
    handlers.set(method, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) handlers.delete(method);
    };
  };

  const onClose = (handler: () => void): (() => void) => {
    closeHandlers.add(handler);
    return () => {
      closeHandlers.delete(handler);
    };
  };

  const close = (): void => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    settleAllClosed();
  };

  return Object.freeze({ send, on, onClose, close, isOpen: () => open });
};
