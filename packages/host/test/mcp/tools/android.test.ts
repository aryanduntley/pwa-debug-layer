import { describe, it, expect, vi } from 'vitest';
import { androidAttachTool, androidDevicesTool } from '../../../src/mcp/tools/android.js';
import type { AndroidControl, ToolContext } from '../../../src/mcp/tool_registry.js';

const ctxWith = (android?: Partial<AndroidControl>): ToolContext =>
  ({ ...(android !== undefined ? { android: android as AndroidControl } : {}) }) as unknown as ToolContext;

describe('pdl_android_* tools', () => {
  it('errors when the host has no Android bridge', async () => {
    expect((await androidDevicesTool.handler({}, ctxWith())).ok).toBe(false);
  });

  it('pdl_android_devices tells the AI what to ask when the phone is not authorized', async () => {
    const devices = async () => ({ ok: true as const, adbPath: '/adb', devices: [{ serial: 'R5', state: 'unauthorized' as const, rawState: 'unauthorized' }] });
    const r = await androidDevicesTool.handler({}, ctxWith({ devices }));
    expect(r.ok).toBe(true);
    expect(r.next_steps.join(' ')).toMatch(/Allow USB debugging/);
  });

  it('pdl_android_devices points at attach when a phone is ready, and flags missing Chrome', async () => {
    const devices = async () => ({ ok: true as const, adbPath: '/adb', devices: [{ serial: 'R5', state: 'device' as const, rawState: 'device', sockets: [] }] });
    const steps = (await androidDevicesTool.handler({}, ctxWith({ devices }))).next_steps.join(' ');
    expect(steps).toMatch(/pdl_android_attach/);
    expect(steps).toMatch(/open Chrome on the phone/);
  });

  it.each([
    ['not_installed', /platform-tools/],
    ['no_device', /USB debugging/],
    ['offline', /replug/],
    ['no_socket', /open Chrome/],
  ] as const)('maps %s failures to user guidance', async (kind, re) => {
    const attach = async () => ({ ok: false as const, kind, message: 'x' });
    const r = await androidAttachTool.handler({}, ctxWith({ attach }));
    expect(r.ok).toBe(false);
    expect(r.next_steps.join(' ')).toMatch(re);
  });

  it('pdl_android_attach passes args through and returns the connection id guidance', async () => {
    const attach = vi.fn(async () => ({
      ok: true as const,
      serial: 'R5',
      model: 'SM_S928U1',
      socket: { socket: 'chrome_devtools_remote', kind: 'chrome' as const },
      browserUrl: '127.0.0.1:40001',
      forwardReused: false,
      reversed: [5173],
      connectionId: 'cdp:127.0.0.1:40001:NEW',
      url: 'http://localhost:5173',
      title: '',
      reused: false,
      loadStatus: 'complete' as const,
      bridge: {},
    }));
    const r = await androidAttachTool.handler({ open_url: 'http://localhost:5173', reverse_ports: [5173] }, ctxWith({ attach }));
    expect(attach).toHaveBeenCalledWith({ openUrl: 'http://localhost:5173', reversePorts: [5173] });
    expect(r.next_steps[0]).toContain('extension_id: "cdp:127.0.0.1:40001:NEW"');
    expect(r.next_steps.join(' ')).toContain('http://localhost:5173');
  });
});
