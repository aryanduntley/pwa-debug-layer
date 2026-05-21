import { describe, it, expect } from 'vitest';
import { createLaunchRegistry } from '../../../src/browser_launch/registry.js';
import {
  browserStatusCore,
  type BrowserStatusDeps,
} from '../../../src/mcp/tools/browser_status.js';
import {
  checkSetupCore,
  type CheckSetupDeps,
} from '../../../src/mcp/tools/check_setup.js';
import {
  installExtensionCore,
  type InstallExtensionDeps,
} from '../../../src/mcp/tools/install_extension.js';
import type { LaunchRecord } from '../../../src/browser_launch/registry.js';
import type { BrowserInstall } from '../../../src/native-messaging/browser_paths.js';

describe('createLaunchRegistry', () => {
  it('records launches newest-last with a now stamp and freezes the list', () => {
    let t = 100;
    const reg = createLaunchRegistry({ now: () => (t += 10) });
    reg.record({
      browser: 'chrome',
      profileType: 'existing',
      port: 9222,
      pid: 1,
      browserUrl: 'http://127.0.0.1:9222',
    });
    reg.record({
      browser: 'brave',
      profileType: 'sandbox-temp',
      port: 9333,
      pid: 2,
      browserUrl: 'http://127.0.0.1:9333',
      userDataDir: '/tmp/x',
    });
    const list = reg.list();
    expect(list.map((r) => r.browser)).toEqual(['chrome', 'brave']);
    expect(list[0]?.launchedAt).toBe(110);
    expect(list[1]?.launchedAt).toBe(120);
    expect(Object.isFrozen(list)).toBe(true);
  });
});

const record = (over: Partial<LaunchRecord> = {}): LaunchRecord =>
  Object.freeze({
    browser: 'chrome',
    profileType: 'existing',
    port: 9222,
    pid: 10,
    browserUrl: 'http://127.0.0.1:9222',
    launchedAt: 1000,
    ...over,
  });

describe('browserStatusCore', () => {
  const base = (over: Partial<BrowserStatusDeps>): BrowserStatusDeps => ({
    listLaunches: () => [],
    probePort: async () => false,
    listConnections: () => [],
    now: () => 5000,
    ...over,
  });

  it('reports no launches and no extension', async () => {
    const res = await browserStatusCore(base({}));
    expect(res.ok).toBe(true);
    expect((res.data as { managedLaunches: unknown[] }).managedLaunches).toEqual([]);
    expect(res.next_steps.join(' ')).toContain('No browsers launched');
  });

  it('re-probes liveness and flags dead ports', async () => {
    const res = await browserStatusCore(
      base({
        listLaunches: () => [record({ port: 9222 }), record({ port: 9333, browser: 'brave' })],
        probePort: async (p) => p === 9222,
      }),
    );
    const data = res.data as {
      managedLaunches: Array<{ port: number; debugPortLive: boolean }>;
    };
    expect(data.managedLaunches.find((l) => l.port === 9222)?.debugPortLive).toBe(true);
    expect(data.managedLaunches.find((l) => l.port === 9333)?.debugPortLive).toBe(false);
    expect(res.next_steps.join(' ')).toContain('no longer answer');
  });

  it('computes heartbeat age for active extensions', async () => {
    const res = await browserStatusCore(
      base({
        listConnections: () => [
          { extensionId: 'abc', connectedAt: 100, lastSeenAt: 4200 },
        ],
        now: () => 5000,
      }),
    );
    const data = res.data as {
      activeExtensions: Array<{ extensionId: string; heartbeatAgeMs: number }>;
    };
    expect(data.activeExtensions[0]).toMatchObject({
      extensionId: 'abc',
      heartbeatAgeMs: 800,
    });
  });
});

describe('checkSetupCore', () => {
  const allGood = (over: Partial<CheckSetupDeps>): CheckSetupDeps => ({
    probeChromeDevtools: async () => true,
    detectInstalls: async () =>
      [
        Object.freeze({
          browser: 'chrome',
          kind: 'native',
          manifestDir: '/c/google-chrome/NativeMessagingHosts',
        }),
      ] as readonly BrowserInstall[],
    manifestExists: async () => true,
    resolveExtensionPath: () => '/ext/dist',
    loadState: async () => ({ extensionIds: ['abc'] }),
    listConnections: () => [{ extensionId: 'abc' }],
    ...over,
  });

  it('ok=true with no gaps when everything is present', async () => {
    const res = await checkSetupCore(allGood({}));
    const data = res.data as { ok: boolean; gaps: string[] };
    expect(data.ok).toBe(true);
    expect(data.gaps).toEqual([]);
  });

  it('flags a missing chrome-devtools-mcp', async () => {
    const res = await checkSetupCore(allGood({ probeChromeDevtools: async () => false }));
    const data = res.data as { ok: boolean; gaps: string[]; recommendations: string[] };
    expect(data.ok).toBe(false);
    expect(data.gaps.join(' ')).toContain('chrome-devtools-mcp');
    expect(data.recommendations.join(' ')).toContain('claude mcp add chrome-devtools');
  });

  it('flags a missing manifest when installs exist but none has one on disk', async () => {
    const res = await checkSetupCore(allGood({ manifestExists: async () => false }));
    const data = res.data as { gaps: string[] };
    expect(data.gaps.join(' ')).toContain('manifest is not installed');
  });

  it('flags a missing extension dist', async () => {
    const res = await checkSetupCore(allGood({ resolveExtensionPath: () => null }));
    const data = res.data as { gaps: string[]; recommendations: string[] };
    expect(data.gaps.join(' ')).toContain('extension dist');
    expect(data.recommendations.join(' ')).toContain('pdl_install_extension');
  });

  it('flags no registered extension id', async () => {
    const res = await checkSetupCore(allGood({ loadState: async () => ({ extensionIds: [] }) }));
    const data = res.data as { gaps: string[] };
    expect(data.gaps.join(' ')).toContain('No extension ID');
  });
});

describe('installExtensionCore', () => {
  const make = (over: Partial<InstallExtensionDeps>): InstallExtensionDeps & {
    copies: Array<{ src: string; dest: string }>;
  } => {
    const copies: Array<{ src: string; dest: string }> = [];
    return {
      copies,
      resolveSource: () => '/ext/dist',
      defaultTarget: () => '/home/u/Downloads/pwa-debug-extension',
      copyDir: async (src, dest) => {
        copies.push({ src, dest });
      },
      ...over,
    };
  };

  it('copies to the default target', async () => {
    const deps = make({});
    const res = await installExtensionCore({}, deps);
    expect(res.ok).toBe(true);
    expect(deps.copies).toEqual([
      { src: '/ext/dist', dest: '/home/u/Downloads/pwa-debug-extension' },
    ]);
    expect((res.data as { dest: string }).dest).toContain('pwa-debug-extension');
  });

  it('copies to a custom target', async () => {
    const deps = make({});
    await installExtensionCore({ target: '/opt/ext' }, deps);
    expect(deps.copies[0]?.dest).toBe('/opt/ext');
  });

  it('errors with build guidance when no source is found (no copy)', async () => {
    const deps = make({ resolveSource: () => null });
    const res = await installExtensionCore({}, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('was not found');
    expect(deps.copies).toHaveLength(0);
  });

  it('errors when the copy fails', async () => {
    const deps = make({
      copyDir: async () => {
        throw new Error('EACCES');
      },
    });
    const res = await installExtensionCore({ target: '/root/x' }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Failed to copy');
  });
});
