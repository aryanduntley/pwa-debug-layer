import { describe, it, expect, vi } from 'vitest';
import { createTransportRouter } from '../../src/transport/router.js';
import { fromIpcServer } from '../../src/transport/extension_transport.js';
import type { Transport, TransportConnectionInfo } from '../../src/transport/types.js';
import type { IpcServer } from '../../src/mcp/ipc/ipc_server.js';
import type { IpcRequestEnvelope } from '../../src/mcp/ipc/envelope.js';

const env = (tool: string): IpcRequestEnvelope =>
  Object.freeze({ type: 'request', requestId: `r-${tool}`, tool, extensionId: 'x', payload: {} });

const conn = (id: string, kind: 'extension' | 'cdp'): TransportConnectionInfo =>
  Object.freeze({ extensionId: id, connectedAt: 1, lastSeenAt: 2, kind });

const fakeTransport = (
  kind: 'extension' | 'cdp',
  ids: () => readonly string[],
): Transport & { readonly calls: string[] } => {
  const calls: string[] = [];
  return {
    kind,
    calls,
    listConnections: () => ids().map((id) => conn(id, kind)),
    request: async (id, e) => {
      calls.push(`request:${id}:${e.tool}`);
      return { type: 'response', requestId: e.requestId, payload: { via: kind } };
    },
    sendTo: (id) => {
      calls.push(`sendTo:${id}`);
      return { ok: true };
    },
    close: vi.fn(async () => undefined),
  };
};

describe('createTransportRouter', () => {
  it('merges connections from every transport, keeping kind', () => {
    const r = createTransportRouter([
      fakeTransport('extension', () => ['ext-a']),
      fakeTransport('cdp', () => ['cdp:phone:1', 'cdp:phone:2']),
    ]);
    expect(r.listConnections().map((c) => `${c.kind}/${c.extensionId}`)).toEqual([
      'extension/ext-a',
      'cdp/cdp:phone:1',
      'cdp/cdp:phone:2',
    ]);
  });

  it('dispatches request and sendTo to the owning transport', async () => {
    const ext = fakeTransport('extension', () => ['ext-a']);
    const cdp = fakeTransport('cdp', () => ['cdp:1']);
    const r = createTransportRouter([ext, cdp]);

    expect((await r.request('cdp:1', env('session_ping'))).payload).toEqual({ via: 'cdp' });
    expect((await r.request('ext-a', env('evaluate'))).payload).toEqual({ via: 'extension' });
    expect(r.sendTo('ext-a', env('x'))).toEqual({ ok: true });
    expect(ext.calls).toEqual(['request:ext-a:evaluate', 'sendTo:ext-a']);
    expect(cdp.calls).toEqual(['request:cdp:1:session_ping']);
  });

  it('resolves ownership per call as connections come and go', async () => {
    let ids: readonly string[] = [];
    const cdp = fakeTransport('cdp', () => ids);
    const r = createTransportRouter([cdp]);
    await expect(r.request('cdp:late', env('t'))).rejects.toThrow(/no connected NMH for cdp:late/);
    ids = ['cdp:late'];
    await expect(r.request('cdp:late', env('t'))).resolves.toMatchObject({ payload: { via: 'cdp' } });
  });

  it('fails unknown ids with the historical IPC wording', async () => {
    const r = createTransportRouter([fakeTransport('extension', () => ['ext-a'])]);
    await expect(r.request('nope', env('t'))).rejects.toThrow('no connected NMH for nope');
    expect(r.sendTo('nope', env('t'))).toEqual({ ok: false, error: 'no connected NMH for nope' });
  });

  it('closes every transport', async () => {
    const a = fakeTransport('extension', () => []);
    const b = fakeTransport('cdp', () => []);
    await createTransportRouter([a, b]).close();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
  });

  it('works with no transports', async () => {
    const r = createTransportRouter([]);
    expect(r.listConnections()).toEqual([]);
    await expect(r.request('x', env('t'))).rejects.toThrow(/no connected NMH/);
  });
});

describe('fromIpcServer', () => {
  it('tags IPC connections as extension and delegates calls unchanged', async () => {
    const request = vi.fn(async (_id: string, e: IpcRequestEnvelope) => ({
      type: 'response' as const,
      requestId: e.requestId,
      payload: 'ok',
    }));
    const sendTo = vi.fn(() => ({ ok: true as const }));
    const close = vi.fn(async () => undefined);
    const ipc: IpcServer = {
      listConnections: () => [{ extensionId: 'ext-a', connectedAt: 1, lastSeenAt: 2 }],
      request,
      sendTo,
      close,
    };
    const t = fromIpcServer(ipc);
    expect(t.kind).toBe('extension');
    expect(t.listConnections()).toEqual([conn('ext-a', 'extension')]);
    await t.request('ext-a', env('session_ping'), { timeoutMs: 5 });
    expect(request).toHaveBeenCalledWith('ext-a', env('session_ping'), { timeoutMs: 5 });
    t.sendTo('ext-a', env('x'));
    expect(sendTo).toHaveBeenCalledOnce();
    await t.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('routes end to end through the router', async () => {
    const ipc: IpcServer = {
      listConnections: () => [{ extensionId: 'ext-a', connectedAt: 1, lastSeenAt: 2 }],
      request: async (_id, e) => ({ type: 'response', requestId: e.requestId, payload: 'pong' }),
      sendTo: () => ({ ok: true }),
      close: async () => undefined,
    };
    const r = createTransportRouter([fromIpcServer(ipc)]);
    expect(r.listConnections()[0]?.kind).toBe('extension');
    expect((await r.request('ext-a', env('session_ping'))).payload).toBe('pong');
  });
});
