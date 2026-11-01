import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectCdp } from '../../src/cdp_client/client.js';
import { isCdpError, type WebSocketCtor } from '../../src/cdp_client/types.js';

type Listener = (ev?: { data: unknown }) => void;

/** Controllable stand-in for the WHATWG WebSocket. */
const makeFakeSocket = (behaviour: 'open' | 'refuse' | 'hang' = 'open') => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    listeners = new Map<string, Listener[]>();
    constructor(public url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        if (behaviour === 'open') {
          this.readyState = 1;
          this.fire('open');
        } else if (behaviour === 'refuse') {
          this.readyState = 3;
          this.fire('error');
        }
      });
    }
    addEventListener(type: string, l: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.fire('close');
    }
    fire(type: string, ev?: { data: unknown }) {
      for (const l of this.listeners.get(type) ?? []) l(ev);
    }
    reply(msg: unknown) {
      this.fire('message', { data: JSON.stringify(msg) });
    }
  }
  return { Ctor: FakeSocket as unknown as WebSocketCtor, sockets };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('connectCdp', () => {
  it('correlates responses to commands by id, even out of order', async () => {
    const f = makeFakeSocket();
    const c = await connectCdp('ws://x', { WebSocketImpl: f.Ctor });
    const s = f.sockets[0]!;
    const a = c.send('Runtime.evaluate', { expression: '1' });
    const b = c.send('Page.enable');
    expect(s.sent.map((m) => m['method'])).toEqual(['Runtime.evaluate', 'Page.enable']);
    s.reply({ id: s.sent[1]!['id'], result: { b: true } });
    s.reply({ id: s.sent[0]!['id'], result: { a: true } });
    await expect(a).resolves.toEqual({ a: true });
    await expect(b).resolves.toEqual({ b: true });
  });

  it('includes sessionId when given and omits params when absent', async () => {
    const f = makeFakeSocket();
    const c = await connectCdp('ws://x', { WebSocketImpl: f.Ctor });
    void c.send('Target.getTargets', undefined, { sessionId: 'S1' });
    expect(f.sockets[0]!.sent[0]).toEqual({ id: 1, method: 'Target.getTargets', sessionId: 'S1' });
  });

  it('maps protocol errors to CdpError kind protocol with code', async () => {
    const f = makeFakeSocket();
    const c = await connectCdp('ws://x', { WebSocketImpl: f.Ctor });
    const p = c.send('Nope.method');
    f.sockets[0]!.reply({ id: 1, error: { code: -32601, message: "'Nope.method' wasn't found" } });
    const err = await p.catch((e: unknown) => e);
    expect(isCdpError(err)).toBe(true);
    expect(err).toMatchObject({ kind: 'protocol', code: -32601 });
    expect((err as Error).message).toContain('Nope.method');
  });

  it('times out a command that never answers', async () => {
    const f = makeFakeSocket();
    const c = await connectCdp('ws://x', { WebSocketImpl: f.Ctor, defaultTimeoutMs: 20 });
    await expect(c.send('Slow.call')).rejects.toMatchObject({ kind: 'timeout' });
    await expect(c.send('Slow.call', {}, { timeoutMs: 5 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('fans events out to subscribers and supports unsubscribe', async () => {
    const f = makeFakeSocket();
    const c = await connectCdp('ws://x', { WebSocketImpl: f.Ctor });
    const h1 = vi.fn();
    const h2 = vi.fn();
    const off1 = c.on('Runtime.bindingCalled', h1);
    c.on('Runtime.bindingCalled', h2);
    f.sockets[0]!.reply({ method: 'Runtime.bindingCalled', params: { name: 'b', payload: 'p' }, sessionId: 'S' });
    expect(h1).toHaveBeenCalledWith({ name: 'b', payload: 'p' }, 'S');
    off1();
    f.sockets[0]!.reply({ method: 'Runtime.bindingCalled', params: {} });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledTimes(2);
  });

  it('keeps delivering to other handlers when one throws', async () => {
    const f = makeFakeSocket();
    const c = await connectCdp('ws://x', { WebSocketImpl: f.Ctor });
    const good = vi.fn();
    c.on('E', () => {
      throw new Error('bad');
    });
    c.on('E', good);
    f.sockets[0]!.reply({ method: 'E', params: 1 });
    expect(good).toHaveBeenCalledOnce();
  });

  it('rejects pending commands and runs close handlers once when the socket closes', async () => {
    const f = makeFakeSocket();
    const c = await connectCdp('ws://x', { WebSocketImpl: f.Ctor });
    const onClose = vi.fn();
    c.onClose(onClose);
    const p = c.send('Page.navigate', { url: 'x' });
    f.sockets[0]!.close();
    await expect(p).rejects.toMatchObject({ kind: 'closed' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(c.isOpen()).toBe(false);
    await expect(c.send('After.close')).rejects.toMatchObject({ kind: 'closed' });
    c.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores garbage frames and unknown ids', async () => {
    const f = makeFakeSocket();
    const c = await connectCdp('ws://x', { WebSocketImpl: f.Ctor });
    const p = c.send('A');
    f.sockets[0]!.fire('message', { data: 'not json' });
    f.sockets[0]!.reply({ id: 999, result: {} });
    f.sockets[0]!.reply({ id: 1, result: { done: 1 } });
    await expect(p).resolves.toEqual({ done: 1 });
  });

  it('fails to connect with connect_failed when the socket errors', async () => {
    const f = makeFakeSocket('refuse');
    await expect(connectCdp('ws://x', { WebSocketImpl: f.Ctor })).rejects.toMatchObject({ kind: 'connect_failed' });
  });

  it('times out a connect that never opens', async () => {
    const f = makeFakeSocket('hang');
    await expect(
      connectCdp('ws://x', { WebSocketImpl: f.Ctor, connectTimeoutMs: 10 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports no_websocket when no implementation exists', async () => {
    const g = globalThis as { WebSocket?: unknown };
    const saved = g.WebSocket;
    g.WebSocket = undefined;
    try {
      await expect(connectCdp('ws://x')).rejects.toMatchObject({ kind: 'no_websocket' });
    } finally {
      g.WebSocket = saved;
    }
  });
});
