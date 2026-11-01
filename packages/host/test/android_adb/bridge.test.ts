import { describe, it, expect, vi } from 'vitest';
import { createAndroidBridge } from '../../src/android_adb/bridge.js';
import type { AdbDeps } from '../../src/android_adb/node_deps.js';
import type { CdpTransport } from '../../src/transport/cdp_transport.js';

type Phone = { devices: string; unix: string; forwards: string; reverses: string };

const S24 = 'R5CX52E7J8X device usb:5-1 product:e3quew model:SM_S928U1 device:e3q transport_id:7';
const CHROME_SOCKET = '0: 00000002 0 00010000 0001 01 1 @chrome_devtools_remote';

/** Fake adb that keeps forward/reverse state, so cleanup can be checked. */
const fakeAdb = (phone: Partial<Phone> = {}) => {
  const state = {
    devices: `List of devices attached\n${S24}\n`,
    unix: `${CHROME_SOCKET}\n`,
    forwards: '',
    reverses: '',
    ...phone,
  };
  const calls: string[][] = [];
  const deps: AdbDeps = {
    which: async () => '/usr/bin/adb',
    fileExists: async () => false,
    env: {},
    platform: 'linux',
    run: async (_p, args) => {
      calls.push([...args]);
      const a = args.join(' ');
      if (a === 'devices -l') return { code: 0, stdout: state.devices, stderr: '' };
      if (a.endsWith('cat /proc/net/unix')) return { code: 0, stdout: state.unix, stderr: '' };
      if (a === 'forward --list') return { code: 0, stdout: state.forwards, stderr: '' };
      if (a.endsWith('reverse --list')) return { code: 0, stdout: state.reverses, stderr: '' };
      const fwd = /^-s (\S+) forward tcp:0 (\S+)$/.exec(a);
      if (fwd) {
        state.forwards += `${fwd[1]} tcp:40001 ${fwd[2]}\n`;
        return { code: 0, stdout: '40001\n', stderr: '' };
      }
      const rev = /^-s \S+ reverse tcp:(\d+) tcp:\d+$/.exec(a);
      if (rev) {
        state.reverses += `UsbFfs tcp:${rev[1]} tcp:${rev[1]}\n`;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { deps, calls, state };
};

const fakeCdp = () => {
  const target = { id: '175', type: 'page', title: 'Fixture', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://x' };
  const attach = vi.fn(async (o: { browserUrl: string }) => ({
    ok: true as const,
    connectionId: `cdp:${o.browserUrl}:175`,
    target,
    status: { version: 1 },
    reused: false,
  }));
  const openTab = vi.fn(async (o: { browserUrl: string; url: unknown }) => ({
    ok: true as const,
    connectionId: `cdp:${o.browserUrl}:NEW`,
    target: { ...target, id: 'NEW', url: String(o.url) },
    status: { version: 1 },
    reused: false,
    url: String(o.url),
    loadStatus: 'complete' as const,
  }));
  return { cdp: { attach, openTab } as unknown as Pick<CdpTransport, 'attach' | 'openTab'>, attach, openTab };
};

describe('createAndroidBridge.devices', () => {
  it('reports adb path, devices and sockets for authorized devices only', async () => {
    const adb = fakeAdb({ devices: `List of devices attached\n${S24}\nemulator-5554 unauthorized\n` });
    const b = createAndroidBridge({ adb: adb.deps, cdp: fakeCdp().cdp });
    const r = await b.devices();
    expect(r.ok && r.adbPath).toBe('/usr/bin/adb');
    expect(r.ok ? r.devices.map((d) => [d.serial, d.state, d.sockets?.map((s) => s.socket)]) : []).toEqual([
      ['R5CX52E7J8X', 'device', ['chrome_devtools_remote']],
      ['emulator-5554', 'unauthorized', undefined],
    ]);
  });

  it('reports adb not installed', async () => {
    const adb = fakeAdb();
    const b = createAndroidBridge({ adb: { ...adb.deps, which: async () => null }, cdp: fakeCdp().cdp });
    expect(await b.devices()).toMatchObject({ ok: false, kind: 'not_installed' });
  });
});

describe('createAndroidBridge.attach', () => {
  it('forwards Chrome on the only device and attaches through the local port', async () => {
    const adb = fakeAdb();
    const c = fakeCdp();
    const b = createAndroidBridge({ adb: adb.deps, cdp: c.cdp });
    const r = await b.attach({ urlContains: 'localhost' });
    expect(r).toMatchObject({
      ok: true,
      serial: 'R5CX52E7J8X',
      model: 'SM_S928U1',
      socket: { socket: 'chrome_devtools_remote', kind: 'chrome' },
      browserUrl: '127.0.0.1:40001',
      forwardReused: false,
      connectionId: 'cdp:127.0.0.1:40001:175',
    });
    expect(c.attach).toHaveBeenCalledWith({ browserUrl: '127.0.0.1:40001', urlContains: 'localhost' });
  });

  it('reverses ports and opens a tab when open_url is given', async () => {
    const adb = fakeAdb();
    const c = fakeCdp();
    const b = createAndroidBridge({ adb: adb.deps, cdp: c.cdp });
    const r = await b.attach({ openUrl: 'http://localhost:5173', reversePorts: [5173] });
    expect(adb.calls).toContainEqual(['-s', 'R5CX52E7J8X', 'reverse', 'tcp:5173', 'tcp:5173']);
    expect(c.openTab).toHaveBeenCalledWith({ browserUrl: '127.0.0.1:40001', url: 'http://localhost:5173' });
    expect(r).toMatchObject({ ok: true, url: 'http://localhost:5173', loadStatus: 'complete', reversed: [5173] });
  });

  it('cleanup removes only what it created, leaving pre-existing mappings', async () => {
    const adb = fakeAdb({
      forwards: 'R5CX52E7J8X tcp:9223 localabstract:chrome_devtools_remote\n',
      reverses: 'UsbFfs tcp:5173 tcp:5173\n',
    });
    const b = createAndroidBridge({ adb: adb.deps, cdp: fakeCdp().cdp });
    const r = await b.attach({ reversePorts: [5173, 8080] });
    expect(r).toMatchObject({ ok: true, browserUrl: '127.0.0.1:9223', forwardReused: true });
    await b.cleanup();
    const removals = adb.calls.filter((c) => c.includes('--remove'));
    expect(removals).toEqual([['-s', 'R5CX52E7J8X', 'reverse', '--remove', 'tcp:8080']]);
  });

  it('cleanup removes a forward it created', async () => {
    const adb = fakeAdb();
    const b = createAndroidBridge({ adb: adb.deps, cdp: fakeCdp().cdp });
    await b.attach({});
    await b.cleanup();
    expect(adb.calls).toContainEqual(['-s', 'R5CX52E7J8X', 'forward', '--remove', 'tcp:40001']);
  });

  it.each([
    ['no devices', { devices: 'List of devices attached\n\n' }, 'no_device'],
    ['unauthorized only', { devices: 'List of devices attached\nR5 unauthorized\n' }, 'unauthorized'],
    ['offline only', { devices: 'List of devices attached\nR5 offline\n' }, 'offline'],
    ['two phones', { devices: `List of devices attached\n${S24}\nOTHER device\n` }, 'multiple_devices'],
    ['Chrome not running', { unix: '0: 1 /dev/socket/zygote\n' }, 'no_socket'],
  ])('fails with %s', async (_label, phone, kind) => {
    const b = createAndroidBridge({ adb: fakeAdb(phone).deps, cdp: fakeCdp().cdp });
    expect(await b.attach({})).toMatchObject({ ok: false, kind });
  });

  it('picks a serial explicitly and checks its state', async () => {
    const devices = `List of devices attached\n${S24}\nOTHER unauthorized\n`;
    const b = createAndroidBridge({ adb: fakeAdb({ devices }).deps, cdp: fakeCdp().cdp });
    expect(await b.attach({ serial: 'OTHER' })).toMatchObject({ ok: false, kind: 'unauthorized' });
    expect(await b.attach({ serial: 'NOPE' })).toMatchObject({ ok: false, kind: 'no_device' });
    expect(await b.attach({ serial: 'R5CX52E7J8X' })).toMatchObject({ ok: true });
  });

  it('selects a WebView socket by kind or package, and reports ambiguity', async () => {
    const unix = `${CHROME_SOCKET}\n0: 2 0 00010000 0001 01 2 @webview_devtools_remote_7\n0: 2 0 00010000 0001 01 3 @webview_devtools_remote_8\n`;
    const b = createAndroidBridge({ adb: fakeAdb({ unix }).deps, cdp: fakeCdp().cdp });
    expect(await b.attach({ socket: 'webview' })).toMatchObject({ ok: false, kind: 'ambiguous_socket' });
    expect(await b.attach({ socket: 'webview_devtools_remote_8' })).toMatchObject({ ok: true, socket: { pid: 8 } });
    expect(await b.attach({})).toMatchObject({ ok: true, socket: { kind: 'chrome' } });
    expect(await b.attach({ socket: 'com.nope' })).toMatchObject({ ok: false, kind: 'no_socket' });
  });

  it('passes CDP attach failures through with candidates', async () => {
    const c = fakeCdp();
    c.attach.mockResolvedValueOnce({ ok: false, error: '2 page targets match', candidates: [{ id: 'A', url: 'u1' }, { id: 'B', url: 'u2' }] } as never);
    const b = createAndroidBridge({ adb: fakeAdb().deps, cdp: c.cdp });
    expect(await b.attach({})).toMatchObject({ ok: false, kind: 'attach_failed', candidates: [{ id: 'A', url: 'u1' }, { id: 'B', url: 'u2' }] });
  });
});
