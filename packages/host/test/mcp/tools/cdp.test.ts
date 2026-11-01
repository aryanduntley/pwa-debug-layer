import { describe, it, expect, vi } from 'vitest';
import { cdpAttachTool, cdpDetachTool, cdpTargetsTool } from '../../../src/mcp/tools/cdp.js';
import type { CdpControl, ToolContext } from '../../../src/mcp/tool_registry.js';

const target = { id: 'A1B2C3D4E5F6', type: 'page', title: 'Fixture', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://x' };

const ctxWith = (cdp?: Partial<CdpControl>): ToolContext =>
  ({ ...(cdp !== undefined ? { cdp: cdp as CdpControl } : {}) }) as unknown as ToolContext;

describe('pdl_cdp_* tools', () => {
  it('errors clearly when the host has no CDP transport', async () => {
    const r = await cdpTargetsTool.handler({ browser_url: '9222' }, ctxWith());
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });
  });

  it('pdl_cdp_targets lists pages with connection ids and phone hints on failure', async () => {
    const targets = vi.fn(async () => ({
      ok: true as const,
      browserUrl: 'http://127.0.0.1:9223',
      version: { browser: 'Chrome/156', protocolVersion: '1.3', userAgent: '', androidPackage: 'com.android.chrome' },
      targets: [{ ...target, type: 'page' as const, connectionId: 'cdp:127.0.0.1:9223:A1B2C3D4', attached: false }],
    }));
    const r = await cdpTargetsTool.handler({ browser_url: '9223' }, ctxWith({ targets }));
    expect(r.data).toEqual({
      browserUrl: 'http://127.0.0.1:9223',
      browser: 'Chrome/156',
      androidPackage: 'com.android.chrome',
      targets: [{ id: target.id, connectionId: 'cdp:127.0.0.1:9223:A1B2C3D4', attached: false, title: 'Fixture', url: target.url }],
    });
    const failing = await cdpTargetsTool.handler({ browser_url: '9223' }, ctxWith({ targets: async () => ({ ok: false as const, error: 'no debug endpoint' }) }));
    expect(failing.next_steps.join(' ')).toMatch(/adb forward tcp:9223 localabstract:chrome_devtools_remote/);
  });

  it('pdl_cdp_attach passes options through and tells the AI to use the connection id', async () => {
    const attach = vi.fn(async () => ({
      ok: true as const,
      connectionId: 'cdp:127.0.0.1:9223:A1B2C3D4',
      target,
      status: { version: 1, captures: 'installed' },
      reused: false,
    }));
    const r = await cdpAttachTool.handler({ browser_url: '9223', url_contains: 'localhost', reload: true }, ctxWith({ attach }));
    expect(attach).toHaveBeenCalledWith({ browserUrl: '9223', urlContains: 'localhost', reload: true });
    expect(r.data).toMatchObject({ connectionId: 'cdp:127.0.0.1:9223:A1B2C3D4', url: target.url, reused: false });
    expect(r.next_steps[0]).toContain('extension_id: "cdp:127.0.0.1:9223:A1B2C3D4"');
  });

  it('pdl_cdp_attach lists candidates when ambiguous and flags extension-owned captures', async () => {
    const amb = await cdpAttachTool.handler(
      { browser_url: '9223' },
      ctxWith({ attach: async () => ({ ok: false as const, error: '2 page targets match', candidates: [target, { ...target, id: 'FFFF0000', url: 'https://b.dev/' }] }) }),
    );
    expect(amb.next_steps[0]).toMatch(/A1B2C3D4 http:\/\/localhost:5173\/ \| FFFF0000 https:\/\/b.dev\//);
    const shared = await cdpAttachTool.handler(
      { browser_url: '9222' },
      ctxWith({ attach: async () => ({ ok: true as const, connectionId: 'c', target, status: { captures: 'skipped_extension_present' }, reused: false }) }),
    );
    expect(shared.next_steps.join(' ')).toMatch(/extension is also running/);
  });

  it('pdl_cdp_detach reports success and unknown ids', async () => {
    const detach = vi.fn(async (id: string) => id === 'cdp:a');
    expect((await cdpDetachTool.handler({ connection_id: 'cdp:a' }, ctxWith({ detach }))).ok).toBe(true);
    expect((await cdpDetachTool.handler({ connection_id: 'cdp:b' }, ctxWith({ detach }))).ok).toBe(false);
  });
});

describe('CDP-aware guidance in existing tools', () => {
  const cdpId = 'cdp:127.0.0.1:9223:2F5A0D34';
  const ctxReturning = (payload: unknown) =>
    ({
      ipcServer: {
        listConnections: () => [{ extensionId: cdpId, connectedAt: 1, lastSeenAt: 1, kind: 'cdp' }],
        request: async (_id: string, env: { requestId: string }) => ({ type: 'response', requestId: env.requestId, payload }),
        sendTo: () => ({ ok: true }),
        close: async () => undefined,
      },
    }) as unknown as ToolContext;

  it('session_ping describes the CDP path, not the extension chain', async () => {
    const { sessionPingHandler } = await import('../../../src/mcp/tools/session_ping.js');
    const r = await sessionPingHandler({}, ctxReturning({ extensionVersion: 'cdp-bridge/1', attachedTabId: null, pageWorld: { url: 'http://localhost:5173/', title: 'F', readyState: 'complete' } }));
    expect(r.next_steps[0]).toMatch(/CDP connection, no extension involved/);
    expect(r.next_steps.join(' ')).not.toMatch(/NMH/);
  });

  it('pdl_new_tab over CDP points at the new connection id, not tabId', async () => {
    const { newTabHandler } = await import('../../../src/mcp/tools/navigation.js');
    const r = await newTabHandler({ url: 'localhost:5173' }, ctxReturning({ tabId: null, url: 'localhost:5173', status: 'complete', created: true, connectionId: 'cdp:127.0.0.1:9223:NEWTAB00' }));
    expect(r.next_steps[0]).toContain('extension_id: "cdp:127.0.0.1:9223:NEWTAB00"');
  });
});
