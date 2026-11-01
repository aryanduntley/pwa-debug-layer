import { describe, it, expect, vi } from 'vitest';
import { CDP_EMIT_BINDING } from '@pwa-debug/shared';
import { attachSession, CDP_SESSION_VERSION_LABEL } from '../../src/cdp_session/session.js';
import { bridgeResult, fakeCdpClient } from './fake_cdp.js';

const STATUS = { version: 1, captures: 'installed', kinds: {}, dropped: 0, alreadyInstalled: false };

/** Respond like a page with the bridge installed. */
const bridgePage = (pageHandler: (tool: string, payload: unknown) => unknown = (tool) => ({ tool })) =>
  (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'S1' };
    if (method === 'Runtime.evaluate') {
      const expr = String(params?.['expression'] ?? '');
      if (expr.includes('.status?.()')) return { result: { value: STATUS } };
      const m = /dispatch\((.*)\)$/.exec(expr);
      if (m) {
        const req = JSON.parse(JSON.parse(m[1]!) as string) as { requestId: string; tool: string; payload?: unknown };
        return bridgeResult({ ns: 'pwa-debug', dir: 'page->cs', requestId: req.requestId, payload: pageHandler(req.tool, req.payload) });
      }
      return { result: {} };
    }
    if (method === 'Page.navigate') return { frameId: 'F' };
    return {};
  };

const req = (tool: string, payload?: unknown) => ({ type: 'request' as const, requestId: `r-${tool}`, tool, ...(payload !== undefined ? { payload } : {}) });

describe('attachSession', () => {
  it('enables domains, adds the binding before injecting, and reads status', async () => {
    const f = fakeCdpClient(bridgePage());
    const s = await attachSession({ client: f.client, bundleSource: 'BUNDLE', connectionId: 'cdp:x:1:A', onEvent: vi.fn() });
    expect(f.methods()).toEqual([
      'Runtime.enable',
      'Page.enable',
      'Inspector.enable',
      'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
      'Runtime.evaluate',
    ]);
    expect(f.sent[3]!.params).toEqual({ name: CDP_EMIT_BINDING });
    expect(f.sent[4]!.params).toEqual({ source: 'BUNDLE' });
    expect(f.sent[5]!.params).toEqual({ expression: 'BUNDLE' });
    expect(s.status).toEqual(STATUS);
  });

  it('reloads instead of injecting live when asked, waiting for load', async () => {
    const f = fakeCdpClient((method, params) => {
      if (method === 'Page.reload') queueMicrotask(() => f.emit('Page.loadEventFired', { timestamp: 1 }));
      return bridgePage()(method, params);
    });
    await attachSession({ client: f.client, bundleSource: 'BUNDLE', connectionId: 'c', onEvent: vi.fn(), reload: true });
    expect(f.methods()).toContain('Page.reload');
    expect(f.sent.filter((s) => s.method === 'Runtime.evaluate' && s.params?.['expression'] === 'BUNDLE')).toHaveLength(0);
  });

  it('routes binding events to onEvent as captures envelopes', async () => {
    const f = fakeCdpClient(bridgePage());
    const onEvent = vi.fn();
    await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'cdp:x:1:A', onEvent });
    f.emit('Runtime.bindingCalled', { name: CDP_EMIT_BINDING, payload: JSON.stringify({ v: 1, event: { kind: 'console', ts: 9, args: ['hi'] } }) });
    f.emit('Runtime.bindingCalled', { name: 'other', payload: '{}' });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith('cdp:x:1:A', {
      type: 'event',
      tool: 'captures',
      extensionId: 'cdp:x:1:A',
      payload: { events: [{ kind: 'console', ts: 9, args: ['hi'] }] },
    });
  });

  it('forwards tools through the bridge without tab_id, honouring the timeout', async () => {
    const seen: unknown[] = [];
    const f = fakeCdpClient(bridgePage((tool, payload) => {
      seen.push({ tool, payload });
      return { value: 2 };
    }));
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    const r = await s.request(req('evaluate', { expression: '1+1', tab_id: 7 }), { timeoutMs: 1234 });
    expect(r).toEqual({ type: 'response', requestId: 'r-evaluate', payload: { value: 2 } });
    expect(seen).toEqual([{ tool: 'evaluate', payload: { expression: '1+1' } }]);
    const last = f.sent.at(-1)!;
    expect(last.params).toMatchObject({ awaitPromise: true, returnByValue: true });
    expect(last.timeoutMs).toBe(1234);
  });

  it('answers session_ping in the extension shape', async () => {
    const f = fakeCdpClient(bridgePage(() => ({ url: 'http://localhost:5173/', title: 'Fixture', readyState: 'complete' })));
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    expect((await s.request(req('session_ping'))).payload).toEqual({
      extensionVersion: CDP_SESSION_VERSION_LABEL,
      attachedTabId: null,
      pageWorld: { url: 'http://localhost:5173/', title: 'Fixture', readyState: 'complete' },
    });
  });

  it('reports a missing bridge in session_ping instead of failing', async () => {
    const f = fakeCdpClient((method, params) =>
      method === 'Runtime.evaluate' && String(params?.['expression']).includes('dispatch(')
        ? { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: Cannot read properties of undefined' } } }
        : bridgePage()(method, params),
    );
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    const p = (await s.request(req('session_ping'))).payload as Record<string, unknown>;
    expect(p['pageWorld']).toBeNull();
    expect(p['pageWorldErrorMessage']).toMatch(/not present/);
  });

  it('navigates with Page.navigate and waits for load', async () => {
    const f = fakeCdpClient((method, params) => {
      if (method === 'Page.navigate') queueMicrotask(() => f.emit('Page.loadEventFired', {}));
      return bridgePage()(method, params);
    });
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    const r = await s.request(req('pdl_navigate', { url: 'localhost:5173' }));
    expect(f.sent.find((x) => x.method === 'Page.navigate')!.params).toEqual({ url: 'localhost:5173' });
    expect(r.payload).toEqual({ tabId: null, url: 'localhost:5173', status: 'complete' });
  });

  it('reports loading when the load event does not arrive in time', async () => {
    const f = fakeCdpClient(bridgePage());
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    const r = await s.request(req('pdl_navigate', { url: 'https://x.dev', timeout_ms: 10 }));
    expect(r.payload).toMatchObject({ status: 'loading' });
  });

  it('surfaces navigation errors and rejects javascript: URLs', async () => {
    const f = fakeCdpClient((method, params) =>
      method === 'Page.navigate' ? { errorText: 'net::ERR_CONNECTION_REFUSED' } : bridgePage()(method, params),
    );
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    expect((await s.request(req('pdl_navigate', { url: 'http://localhost:1', timeout_ms: 10 }))).error?.message).toMatch(/ERR_CONNECTION_REFUSED/);
    expect((await s.request(req('pdl_navigate', { url: 'javascript:alert(1)' }))).error).toBeDefined();
  });

  it('refuses recent_events with a pointer to the tail tools', async () => {
    const f = fakeCdpClient(bridgePage());
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    expect((await s.request(req('recent_events'))).error?.message).toMatch(/console_tail/);
  });

  it('turns a transport failure into an error response', async () => {
    let fail = false;
    const f = fakeCdpClient((method, params) => {
      if (fail) throw new Error('socket gone');
      return bridgePage()(method, params);
    });
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    fail = true;
    expect((await s.request(req('react_tree'))).error?.message).toBe('cdp: react_tree failed: socket gone');
  });

  it('refuses calls while the tab is crashed and recovers on the next load', async () => {
    const f = fakeCdpClient(bridgePage());
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    f.emit('Inspector.targetCrashed', {});
    expect((await s.request(req('react_tree'))).error?.message).toMatch(/tab crashed/);
    f.emit('Page.loadEventFired', {});
    expect((await s.request(req('react_tree'))).error).toBeUndefined();
  });

  it('re-reads status on demand', async () => {
    const f = fakeCdpClient(bridgePage());
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent: vi.fn() });
    expect(await s.readStatus()).toEqual(STATUS);
  });

  it('detach removes the script and binding, stops events, and closes', async () => {
    const f = fakeCdpClient(bridgePage());
    const onEvent = vi.fn();
    const s = await attachSession({ client: f.client, bundleSource: 'B', connectionId: 'c', onEvent });
    await s.detach();
    expect(f.sent.find((x) => x.method === 'Page.removeScriptToEvaluateOnNewDocument')!.params).toEqual({ identifier: 'S1' });
    expect(f.methods()).toContain('Runtime.removeBinding');
    expect(f.client.isOpen()).toBe(false);
    f.emit('Runtime.bindingCalled', { name: CDP_EMIT_BINDING, payload: JSON.stringify({ v: 1, event: { kind: 'console', ts: 1 } }) });
    expect(onEvent).not.toHaveBeenCalled();
  });
});
