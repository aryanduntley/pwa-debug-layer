import { describe, it, expect, vi } from 'vitest';
import { CDP_EMIT_BINDING } from '@pwa-debug/shared';
import { createCdpTransport } from '../../src/transport/cdp_transport.js';
import { createTransportRouter } from '../../src/transport/router.js';
import type { connectCdp } from '../../src/cdp_client/client.js';
import { bridgeResult, fakeCdpClient } from '../cdp_session/fake_cdp.js';

type Page = { id: string; url: string; title?: string; type?: string };

/** A fake debug endpoint: HTTP discovery plus one scripted client per socket. */
const endpoint = (initial: Page[]) => {
  const pages = [...initial];
  const clients = new Map<string, ReturnType<typeof fakeCdpClient>>();
  const wsFor = (id: string) => `ws://127.0.0.1:9334/devtools/page/${id}`;
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/json/version')) {
      return new Response(JSON.stringify({ Browser: 'Chrome/156', 'Android-Package': 'com.android.chrome', webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/browser' }));
    }
    if (url.endsWith('/json/list')) {
      return new Response(JSON.stringify(pages.map((p) => ({ type: 'page', title: '', ...p, webSocketDebuggerUrl: wsFor(p.id) }))));
    }
    return new Response('Could not create new page', { status: 200 });
  }) as unknown as typeof fetch;

  const pageClient = () => {
    const f = fakeCdpClient((method, params) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'S' };
      if (method === 'Page.navigate') {
        queueMicrotask(() => f.emit('Page.loadEventFired', {}));
        return { frameId: 'F' };
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.['expression'] ?? '');
        if (expr.includes('.status?.()')) return { result: { value: { version: 1, captures: 'installed' } } };
        const m = /dispatch\((.*)\)$/.exec(expr);
        if (m) {
          const r = JSON.parse(JSON.parse(m[1]!) as string) as { requestId: string; tool: string };
          return bridgeResult({ requestId: r.requestId, payload: { tool: r.tool } });
        }
      }
      return {};
    });
    return f;
  };

  const connect = (async (wsUrl: string) => {
    if (wsUrl.endsWith('/devtools/browser')) {
      const b = fakeCdpClient((method) => {
        if (method === 'Target.createTarget') {
          pages.push({ id: 'NEWTAB0000000000', url: 'about:blank' });
          return { targetId: 'NEWTAB0000000000' };
        }
        return {};
      });
      clients.set(wsUrl, b);
      return b.client;
    }
    const f = pageClient();
    clients.set(wsUrl, f);
    return f.client;
  }) as unknown as typeof connectCdp;

  return { pages, clients, fetchImpl, connect, wsFor };
};

const make = (pages: Page[], shouldCapture?: (e: { kind: string }) => boolean) => {
  const ep = endpoint(pages);
  const onEvent = vi.fn();
  const loadBundle = vi.fn(async () => 'BUNDLE');
  const t = createCdpTransport({
    onEvent,
    loadBundle,
    connect: ep.connect,
    fetchImpl: ep.fetchImpl,
    now: () => 1000,
    ...(shouldCapture !== undefined ? { shouldCapture } : {}),
  });
  return { ep, t, onEvent, loadBundle };
};

const FIXTURE = { id: 'A1B2C3D4E5F6A7B8', url: 'http://localhost:5173/', title: 'pwa-debug React fixture' };
const NEWTAB = { id: 'FFFF0000FFFF0000', url: 'chrome-native://newtab/' };
const req = (tool: string, payload?: unknown) => ({ type: 'request' as const, requestId: `r-${tool}`, tool, ...(payload !== undefined ? { payload } : {}) });

describe('createCdpTransport.attach', () => {
  it('attaches to the only regular page, ignoring browser-internal pages', async () => {
    const { t, loadBundle } = make([NEWTAB, FIXTURE]);
    const r = await t.attach({ browserUrl: '9334' });
    expect(r).toMatchObject({ ok: true, connectionId: 'cdp:127.0.0.1:9334:A1B2C3D4', reused: false, target: { url: FIXTURE.url } });
    expect(loadBundle).toHaveBeenCalledOnce();
    expect(t.listConnections()).toEqual([
      { extensionId: 'cdp:127.0.0.1:9334:A1B2C3D4', kind: 'cdp', connectedAt: 1000, lastSeenAt: 1000, label: 'pwa-debug React fixture (http://localhost:5173/)' },
    ]);
  });

  it('picks by url substring or target id prefix, and lists candidates when ambiguous', async () => {
    const other = { id: '9999999999999999', url: 'https://example.com/' };
    const { t } = make([FIXTURE, other]);
    const amb = await t.attach({ browserUrl: '127.0.0.1:9334' });
    expect(amb).toMatchObject({ ok: false, error: expect.stringMatching(/2 page targets match/) });
    expect(amb.ok ? [] : amb.candidates?.map((c) => c.id)).toEqual([FIXTURE.id, other.id]);
    expect(await t.attach({ browserUrl: '9334', urlContains: 'example.com' })).toMatchObject({ ok: true, target: { id: other.id } });
    expect(await t.attach({ browserUrl: '9334', targetId: 'A1B2' })).toMatchObject({ ok: true, target: { id: FIXTURE.id } });
    expect(await t.attach({ browserUrl: '9334', targetId: 'nope' })).toMatchObject({ ok: false });
  });

  it('reuses an existing attachment', async () => {
    const { t, loadBundle } = make([FIXTURE]);
    await t.attach({ browserUrl: '9334' });
    expect(await t.attach({ browserUrl: '9334' })).toMatchObject({ ok: true, reused: true });
    expect(loadBundle).toHaveBeenCalledOnce();
  });

  it('rejects an unreadable browser url', async () => {
    const { t } = make([FIXTURE]);
    expect(await t.attach({ browserUrl: 'localhost' })).toMatchObject({ ok: false });
  });
});

describe('createCdpTransport requests and lifecycle', () => {
  it('routes requests and events, and works behind the router next to other transports', async () => {
    const { t, ep, onEvent } = make([FIXTURE]);
    const a = await t.attach({ browserUrl: '9334' });
    if (!a.ok) throw new Error('attach failed');
    const router = createTransportRouter([t]);
    expect((await router.request(a.connectionId, req('react_tree'))).payload).toEqual({ tool: 'react_tree' });
    ep.clients.get(ep.wsFor(FIXTURE.id))!.emit('Runtime.bindingCalled', {
      name: CDP_EMIT_BINDING,
      payload: JSON.stringify({ v: 1, event: { kind: 'console', ts: 2 } }),
    });
    expect(onEvent).toHaveBeenCalledWith(a.connectionId, expect.objectContaining({ tool: 'captures' }));
    expect(router.sendTo(a.connectionId, { type: 'event', tool: 'settings_changed' })).toEqual({ ok: true });
  });

  it('drops events the capture gate rejects', async () => {
    const { t, ep, onEvent } = make([FIXTURE], (e) => e.kind !== 'dom_mutation');
    await t.attach({ browserUrl: '9334' });
    const page = ep.clients.get(ep.wsFor(FIXTURE.id))!;
    const emit = (kind: string) =>
      page.emit('Runtime.bindingCalled', { name: CDP_EMIT_BINDING, payload: JSON.stringify({ v: 1, event: { kind, ts: 1, frameUrl: FIXTURE.url } }) });
    emit('dom_mutation');
    expect(onEvent).not.toHaveBeenCalled();
    emit('console');
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('keeps the connection label current across top-frame navigations', async () => {
    const { t, ep } = make([FIXTURE]);
    await t.attach({ browserUrl: '9334' });
    const page = ep.clients.get(ep.wsFor(FIXTURE.id))!;
    page.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'top', url: 'https://ads.example/' } });
    expect(t.listConnections()[0]!.label).toBe('pwa-debug React fixture (http://localhost:5173/)');
    page.emit('Page.frameNavigated', { frame: { id: 'top', url: 'http://localhost:5173/?from=pwa-debug' } });
    expect(t.listConnections()[0]!.label).toBe('http://localhost:5173/?from=pwa-debug');
  });

  it('drops a connection when its socket closes', async () => {
    const { t, ep } = make([FIXTURE]);
    const a = await t.attach({ browserUrl: '9334' });
    ep.clients.get(ep.wsFor(FIXTURE.id))!.closeRemote();
    expect(t.listConnections()).toEqual([]);
    await expect(t.request(a.ok ? a.connectionId : '', req('x'))).rejects.toThrow(/no connected NMH/);
  });

  it('detaches and closes everything', async () => {
    const { t, ep } = make([FIXTURE, { id: 'B000000000000000', url: 'https://b.dev/' }]);
    const a = await t.attach({ browserUrl: '9334', urlContains: 'localhost' });
    await t.attach({ browserUrl: '9334', urlContains: 'b.dev' });
    expect(await t.detach(a.ok ? a.connectionId : '')).toBe(true);
    expect(await t.detach('cdp:none')).toBe(false);
    expect(t.listConnections()).toHaveLength(1);
    await t.close();
    expect(t.listConnections()).toEqual([]);
    expect(ep.clients.get(ep.wsFor(FIXTURE.id))!.methods()).toContain('Runtime.removeBinding');
  });

  it('opens a new tab blank, attaches it, then navigates', async () => {
    const { t, ep } = make([FIXTURE]);
    const a = await t.attach({ browserUrl: '9334' });
    const r = await t.request(a.ok ? a.connectionId : '', req('pdl_new_tab', { url: 'localhost:5173/?tab=2' }));
    expect(r.payload).toEqual({ tabId: null, url: 'localhost:5173/?tab=2', status: 'complete', created: true, connectionId: 'cdp:127.0.0.1:9334:NEWTAB00' });
    const opened = await t.openTab({ browserUrl: '9334', url: 'https://x.dev' });
    expect(opened).toMatchObject({ ok: true, url: 'https://x.dev', loadStatus: 'complete', status: { version: 1, captures: 'installed' } });
    expect(ep.clients.get('ws://127.0.0.1:9334/devtools/browser')!.sent[0]).toEqual({ method: 'Target.createTarget', params: { url: 'about:blank' } });
    const newPage = ep.clients.get(ep.wsFor('NEWTAB0000000000'))!;
    const m = newPage.methods();
    expect(m.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(m.indexOf('Page.navigate'));
    expect(t.listConnections()).toHaveLength(2);
  });

  it('lists targets with their would-be connection ids and attached flags', async () => {
    const { t } = make([NEWTAB, FIXTURE]);
    await t.attach({ browserUrl: '9334' });
    const r = await t.targets('http://127.0.0.1:9334');
    expect(r).toMatchObject({ ok: true, browserUrl: 'http://127.0.0.1:9334', version: { androidPackage: 'com.android.chrome' } });
    expect(r.ok ? r.targets.map((x) => [x.connectionId, x.attached]) : []).toEqual([
      ['cdp:127.0.0.1:9334:FFFF0000', false],
      ['cdp:127.0.0.1:9334:A1B2C3D4', true],
    ]);
  });
});
