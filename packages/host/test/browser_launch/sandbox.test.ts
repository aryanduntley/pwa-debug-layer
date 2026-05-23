import { describe, it, expect } from 'vitest';
import { buildSandboxSpawnArgs } from '../../src/browser_launch/spawn_args.js';
import {
  defaultExtensionCandidates,
  persistentProfileDir,
  pickExtensionPath,
} from '../../src/browser_launch/sandbox_paths.js';
import {
  createTempCleanupRegistry,
  filterTempProfileNames,
} from '../../src/browser_launch/cleanup.js';
import { launchSandbox } from '../../src/browser_launch/launch_sandbox.js';
import type { LaunchSandboxDeps } from '../../src/browser_launch/types.js';

describe('buildSandboxSpawnArgs', () => {
  it('preloads the extension and pins the profile', () => {
    const { cmd, args } = buildSandboxSpawnArgs(
      '/usr/bin/google-chrome',
      9222,
      '/home/u/.pwa-debug/profiles/chrome',
      '/ext/dist',
    );
    expect(cmd).toBe('/usr/bin/google-chrome');
    expect(args).toEqual([
      '--remote-debugging-port=9222',
      '--user-data-dir=/home/u/.pwa-debug/profiles/chrome',
      '--load-extension=/ext/dist',
      '--disable-extensions-except=/ext/dist',
      '--no-first-run',
      '--no-default-browser-check',
    ]);
  });
});

describe('persistentProfileDir', () => {
  it('builds ~/.pwa-debug/profiles/<browser>', () => {
    expect(persistentProfileDir('brave', { HOME: '/h' })).toBe(
      '/h/.pwa-debug/profiles/brave',
    );
  });
  it('returns null without HOME', () => {
    expect(persistentProfileDir('chrome', {})).toBeNull();
  });
});

describe('extension path resolution', () => {
  it('orders candidates: env override, host-bundled, monorepo sibling (join-normalized)', () => {
    const c = defaultExtensionCandidates(
      { PWA_DEBUG_EXTENSION_PATH: '/override' },
      '/repo/host',
    );
    expect(c).toEqual([
      '/override',
      '/repo/host/extension',
      '/repo/extension/dist',
    ]);
  });
  it('omits the override when unset', () => {
    expect(defaultExtensionCandidates({}, '/repo/host')).toEqual([
      '/repo/host/extension',
      '/repo/extension/dist',
    ]);
  });
  it('pickExtensionPath returns the first dir with a manifest', () => {
    expect(
      pickExtensionPath(['/a', '/b', '/c'], (d) => d === '/b' || d === '/c'),
    ).toBe('/b');
  });
  it('pickExtensionPath returns null when none has a manifest', () => {
    expect(pickExtensionPath(['/a', '/b'], () => false)).toBeNull();
  });
});

describe('createTempCleanupRegistry', () => {
  it('removes each registered dir once and clears the set', () => {
    const removed: string[] = [];
    const reg = createTempCleanupRegistry({ removeDir: (d) => removed.push(d) });
    reg.register('/t/a');
    reg.register('/t/b');
    reg.register('/t/a'); // dedup
    expect(reg.list()).toEqual(['/t/a', '/t/b']);
    reg.cleanupAll();
    expect(removed).toEqual(['/t/a', '/t/b']);
    expect(reg.list()).toEqual([]);
  });
  it('swallows per-dir removal errors', () => {
    const reg = createTempCleanupRegistry({
      removeDir: (d) => {
        if (d === '/bad') throw new Error('boom');
      },
    });
    reg.register('/bad');
    reg.register('/ok');
    expect(() => reg.cleanupAll()).not.toThrow();
    expect(reg.list()).toEqual([]);
  });
});

describe('filterTempProfileNames', () => {
  it('keeps only pwa-debug- prefixed entries from a tmpdir listing', () => {
    expect(
      filterTempProfileNames([
        'pwa-debug-aB12',
        'pwa-debug-cD34',
        'systemd-private-xyz',
        '.X11-unix',
        'snap.chromium',
      ]),
    ).toEqual(['pwa-debug-aB12', 'pwa-debug-cD34']);
  });
  it('returns empty when nothing matches', () => {
    expect(filterTempProfileNames(['tmp1', 'tmp2'])).toEqual([]);
  });
});

describe('launchSandbox', () => {
  const input = {
    browser: 'chrome' as const,
    execPath: '/usr/bin/google-chrome',
    port: 9222,
    userDataDir: '/h/.pwa-debug/profiles/chrome',
    extensionPath: '/ext/dist',
  };

  const makeDeps = (opts: {
    portLive?: boolean;
    pid?: number | null;
  }): LaunchSandboxDeps & {
    spawns: Array<{ cmd: string; args: readonly string[] }>;
    registered: string[];
  } => {
    const spawns: Array<{ cmd: string; args: readonly string[] }> = [];
    const registered: string[] = [];
    return {
      spawns,
      registered,
      probeDebugPort: async () => opts.portLive ?? false,
      spawnBrowser: async (cmd, args) => {
        spawns.push({ cmd, args });
        return { pid: opts.pid ?? 555 };
      },
      registerTempProfile: (dir) => registered.push(dir),
    };
  };

  it('attaches when the port is already live — no spawn, no register', async () => {
    const deps = makeDeps({ portLive: true });
    const r = await launchSandbox(
      { ...input, mode: 'sandbox-persistent' },
      deps,
    );
    expect(r).toMatchObject({
      action: 'attach',
      attached: true,
      profileType: 'sandbox-persistent',
      browserUrl: 'http://127.0.0.1:9222',
      userDataDir: input.userDataDir,
      pid: null,
    });
    expect(deps.spawns).toHaveLength(0);
    expect(deps.registered).toHaveLength(0);
  });

  it('spawns a persistent profile without registering for cleanup', async () => {
    const deps = makeDeps({ portLive: false });
    const r = await launchSandbox(
      { ...input, mode: 'sandbox-persistent' },
      deps,
    );
    expect(r).toMatchObject({
      action: 'spawn-fresh',
      attached: true,
      profileType: 'sandbox-persistent',
      pid: 555,
    });
    expect(deps.spawns[0]?.args).toContain('--load-extension=/ext/dist');
    expect(deps.registered).toHaveLength(0);
  });

  it('spawns a temp profile and registers it for cleanup', async () => {
    const deps = makeDeps({ portLive: false });
    const r = await launchSandbox({ ...input, mode: 'sandbox-temp' }, deps);
    expect(r.profileType).toBe('sandbox-temp');
    expect(deps.spawns).toHaveLength(1);
    expect(deps.registered).toEqual(['/h/.pwa-debug/profiles/chrome']);
  });
});
