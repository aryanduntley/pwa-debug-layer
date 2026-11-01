import type { CdpClient, CdpEventHandler } from '../../src/cdp_client/types.js';

export type Sent = { readonly method: string; readonly params?: Record<string, unknown>; readonly timeoutMs?: number };

/**
 * Scripted CdpClient for tests: `respond` decides each command's result (or
 * throws to reject); `emit` fires an event to subscribers; `closeRemote`
 * simulates the socket dropping.
 */
export const fakeCdpClient = (
  respond: (method: string, params?: Record<string, unknown>) => unknown = () => ({}),
) => {
  const sent: Sent[] = [];
  const handlers = new Map<string, Set<CdpEventHandler>>();
  const closeHandlers = new Set<() => void>();
  let open = true;
  const emit = (method: string, params?: unknown) => {
    for (const h of [...(handlers.get(method) ?? [])]) h(params);
  };
  const closeRemote = () => {
    if (!open) return;
    open = false;
    for (const h of [...closeHandlers]) h();
  };
  const client: CdpClient = {
    send: async (method, params, opts) => {
      sent.push({ method, ...(params !== undefined ? { params } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      if (!open) throw new Error('closed');
      return respond(method, params);
    },
    on: (method, h) => {
      const set = handlers.get(method) ?? new Set();
      set.add(h);
      handlers.set(method, set);
      return () => set.delete(h);
    },
    onClose: (h) => {
      closeHandlers.add(h);
      return () => closeHandlers.delete(h);
    },
    close: closeRemote,
    isOpen: () => open,
  };
  return { client, sent, emit, closeRemote, methods: () => sent.map((s) => s.method) };
};

/** A Runtime.evaluate result whose value is the bridge's JSON response. */
export const bridgeResult = (page: unknown) => ({ result: { type: 'string', value: JSON.stringify(page) } });
