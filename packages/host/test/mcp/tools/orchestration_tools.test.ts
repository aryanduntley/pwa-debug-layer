import { describe, it, expect } from 'vitest';
import {
  createLaunchRegistry,
  parseLaunchRecords,
} from '../../../src/browser_launch/registry.js';
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
import {
  registerChromeDevtoolsCore,
  type RegisterCdpDeps,
} from '../../../src/mcp/tools/register_chrome_devtools.js';
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

  it('supersedes a prior launch on the same port (keeps the list bounded)', () => {
    const reg = createLaunchRegistry({ now: () => 1 });
    reg.record({ browser: 'chrome', profileType: 'existing', port: 9222, pid: 1, browserUrl: null });
    reg.record({ browser: 'brave', profileType: 'existing', port: 9222, pid: 2, browserUrl: null });
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.browser).toBe('brave');
  });

  it('seeds from load() and persists the merged list on each record()', () => {
    const seeded: LaunchRecord = {
      browser: 'chromium',
      profileType: 'sandbox-persistent',
      port: 9300,
      pid: 5,
      browserUrl: 'http://127.0.0.1:9300',
      launchedAt: 1,
    };
    const writes: ReadonlyArray<LaunchRecord>[] = [];
    const reg = createLaunchRegistry({
      now: () => 2,
      load: () => [seeded],
      persist: (recs) => writes.push(recs),
    });
    expect(reg.list().map((r) => r.port)).toEqual([9300]); // restored from prior run
    reg.record({ browser: 'chrome', profileType: 'existing', port: 9222, pid: 1, browserUrl: null });
    expect(reg.list().map((r) => r.port)).toEqual([9300, 9222]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((r) => r.port)).toEqual([9300, 9222]);
  });
});

describe('parseLaunchRecords', () => {
  it('returns [] for non-array / corrupt input', () => {
    expect(parseLaunchRecords(null)).toEqual([]);
    expect(parseLaunchRecords({ nope: 1 })).toEqual([]);
    expect(parseLaunchRecords('garbage')).toEqual([]);
  });

  it('keeps valid records and drops malformed ones', () => {
    const parsed = parseLaunchRecords([
      { browser: 'chrome', profileType: 'existing', port: 9222, pid: 1, browserUrl: 'u', launchedAt: 10 },
      { browser: 'firefox', profileType: 'existing', port: 9222, launchedAt: 10 }, // bad browser
      { browser: 'brave', profileType: 'existing', launchedAt: 10 }, // missing port
      { browser: 'edge', profileType: 'sandbox-temp', port: 9444, pid: null, browserUrl: null, userDataDir: '/t/x', launchedAt: 20 },
    ]);
    expect(parsed.map((r) => r.browser)).toEqual(['chrome', 'edge']);
    expect(parsed[1]?.userDataDir).toBe('/t/x');
    expect(parsed[1]?.pid).toBeNull();
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
    readCdpRegistration: async () => ({
      registered: true,
      browserUrl: 'http://127.0.0.1:9222',
    }),
    defaultPort: () => 9222,
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
    deriveBundledExtensionId: async () => 'abc',
    listManagedPorts: () => [],
    fetchLoadedExtensionIds: async () => [],
    ...over,
  });

  it('ok=true with no gaps when everything is present', async () => {
    const res = await checkSetupCore(allGood({}));
    const data = res.data as { ok: boolean; gaps: string[] };
    expect(data.ok).toBe(true);
    expect(data.gaps).toEqual([]);
  });

  it('flags an unregistered chrome-devtools-mcp with the port-correct add snippet', async () => {
    const res = await checkSetupCore(
      allGood({
        readCdpRegistration: async () => ({ registered: false, browserUrl: null }),
      }),
    );
    const data = res.data as { ok: boolean; gaps: string[]; recommendations: string[] };
    expect(data.ok).toBe(false);
    expect(data.gaps.join(' ')).toContain('not registered');
    expect(data.recommendations.join(' ')).toContain('claude mcp add chrome-devtools');
    expect(data.recommendations.join(' ')).toContain('--browserUrl http://127.0.0.1:9222');
  });

  it('flags a chrome-devtools-mcp registered at the wrong debug port', async () => {
    const res = await checkSetupCore(
      allGood({
        readCdpRegistration: async () => ({
          registered: true,
          browserUrl: 'http://127.0.0.1:9333',
        }),
        defaultPort: () => 9222,
      }),
    );
    const data = res.data as { ok: boolean; gaps: string[]; recommendations: string[] };
    expect(data.ok).toBe(false);
    expect(data.gaps.join(' ')).toContain('does not match the active debug port');
    expect(data.gaps.join(' ')).toContain('9333');
    expect(data.recommendations.join(' ')).toContain('claude mcp remove chrome-devtools');
  });

  it('builds the add snippet against the active managed port, not launch.defaultPort', async () => {
    const res = await checkSetupCore(
      allGood({
        readCdpRegistration: async () => ({ registered: false, browserUrl: null }),
        defaultPort: () => 9222,
        listManagedPorts: () => [{ port: 9444, sandbox: false }],
        fetchLoadedExtensionIds: async () => ['abc'],
      }),
    );
    const data = res.data as { recommendations: string[] };
    expect(data.recommendations.join(' ')).toContain('--browserUrl http://127.0.0.1:9444');
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

  it('flags a loaded-but-unregistered extension on a sandbox port and recommends registering it', async () => {
    const res = await checkSetupCore(
      allGood({
        loadState: async () => ({ extensionIds: ['abc'] }),
        deriveBundledExtensionId: async () => 'wrongid',
        listManagedPorts: () => [{ port: 9222, sandbox: true }],
        fetchLoadedExtensionIds: async () => ['wrongid'],
      }),
    );
    const data = res.data as {
      ok: boolean;
      gaps: string[];
      recommendations: string[];
      detail: { loadedExtensionIds: string[]; bundledExtensionId: string | null };
    };
    expect(data.ok).toBe(false);
    expect(data.gaps.join(' ')).toContain('allowed_origins');
    expect(data.gaps.join(' ')).toContain('wrongid (port 9222)');
    expect(data.recommendations.join(' ')).toContain('host_register_extension wrongid');
    expect(data.detail.loadedExtensionIds).toEqual(['wrongid']);
    expect(data.detail.bundledExtensionId).toBe('wrongid');
  });

  it('does NOT flag the user\'s own extensions loaded in an existing profile', async () => {
    const res = await checkSetupCore(
      allGood({
        loadState: async () => ({ extensionIds: ['abc'] }),
        deriveBundledExtensionId: async () => 'abc',
        listManagedPorts: () => [{ port: 9222, sandbox: false }],
        // 'abc' is ours+registered; 'someuserext' is a foreign extension that
        // legitimately is not whitelisted — must not be flagged in existing mode.
        fetchLoadedExtensionIds: async () => ['abc', 'someuserext'],
      }),
    );
    const data = res.data as { ok: boolean; gaps: string[] };
    expect(data.ok).toBe(true);
    expect(data.gaps).toEqual([]);
  });

  it('statically flags a bundled id that is not registered when no browser is live to probe', async () => {
    const res = await checkSetupCore(
      allGood({
        loadState: async () => ({ extensionIds: ['stale'] }),
        deriveBundledExtensionId: async () => 'bundled',
        listManagedPorts: () => [],
      }),
    );
    const data = res.data as { gaps: string[]; recommendations: string[] };
    expect(data.gaps.join(' ')).toContain('bundled');
    expect(data.gaps.join(' ')).toContain('not registered');
    expect(data.recommendations.join(' ')).toContain('host_register_extension bundled');
  });
});

describe('registerChromeDevtoolsCore', () => {
  const make = (
    over: Partial<RegisterCdpDeps>,
  ): RegisterCdpDeps & { added: string[]; removes: number } => {
    const added: string[] = [];
    let removes = 0;
    return {
      readCdpRegistration: async () => ({ registered: false, browserUrl: null }),
      runMcpAdd: async (browserUrl: string) => {
        added.push(browserUrl);
        return { ok: true, error: null };
      },
      runMcpRemove: async () => {
        removes += 1;
        return { ok: true, error: null };
      },
      defaultPort: () => 9222,
      listManagedPorts: () => [],
      ...over,
      get added() {
        return added;
      },
      get removes() {
        return removes;
      },
    } as RegisterCdpDeps & { added: string[]; removes: number };
  };

  it('no-ops when already registered at the correct port', async () => {
    const deps = make({
      readCdpRegistration: async () => ({
        registered: true,
        browserUrl: 'http://127.0.0.1:9222',
      }),
    });
    const res = await registerChromeDevtoolsCore({}, deps);
    const data = res.data as { action: string };
    expect(res.ok).toBe(true);
    expect(data.action).toBe('noop');
    expect(deps.added).toEqual([]);
    expect(deps.removes).toBe(0);
  });

  it('registers fresh when chrome-devtools is not registered', async () => {
    const deps = make({
      readCdpRegistration: async () => ({ registered: false, browserUrl: null }),
    });
    const res = await registerChromeDevtoolsCore({}, deps);
    const data = res.data as { action: string; browserUrl: string };
    expect(res.ok).toBe(true);
    expect(data.action).toBe('registered');
    expect(deps.added).toEqual(['http://127.0.0.1:9222']);
    expect(deps.removes).toBe(0);
    expect(res.next_steps.join(' ')).toContain('full Claude Code restart is required');
    expect(res.next_steps.join(' ')).toContain('/reload-plugins');
  });

  it('removes then re-adds when registered at the wrong port', async () => {
    const deps = make({
      readCdpRegistration: async () => ({
        registered: true,
        browserUrl: 'http://127.0.0.1:9333',
      }),
    });
    const res = await registerChromeDevtoolsCore({}, deps);
    const data = res.data as { action: string };
    expect(res.ok).toBe(true);
    expect(data.action).toBe('re-registered');
    expect(deps.removes).toBe(1);
    expect(deps.added).toEqual(['http://127.0.0.1:9222']);
  });

  it('prefers the active managed port over launch.defaultPort', async () => {
    const deps = make({
      defaultPort: () => 9222,
      listManagedPorts: () => [{ port: 9444 }],
    });
    await registerChromeDevtoolsCore({}, deps);
    expect(deps.added).toEqual(['http://127.0.0.1:9444']);
  });

  it('honors an explicit port arg over everything else', async () => {
    const deps = make({ listManagedPorts: () => [{ port: 9444 }] });
    await registerChromeDevtoolsCore({ port: 9555 }, deps);
    expect(deps.added).toEqual(['http://127.0.0.1:9555']);
  });

  it('returns an error with the manual snippet when the add fails', async () => {
    const deps = make({
      runMcpAdd: async () => ({ ok: false, error: 'claude: command not found' }),
    });
    const res = await registerChromeDevtoolsCore({}, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Failed to register');
    expect(res.next_steps.join(' ')).toContain('claude mcp add chrome-devtools');
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
