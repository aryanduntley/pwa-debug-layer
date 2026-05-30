import { describe, it, expect } from 'vitest';
import {
  buildSandboxFlatpakArgs,
  buildSandboxSpawnArgs,
} from '../../src/browser_launch/spawn_args.js';
import {
  defaultExtensionCandidates,
  isLoadableExtensionDir,
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
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
    ]);
  });

  it('suppresses the crash/restore bubble so a re-launched sandbox profile never prompts', () => {
    const { args } = buildSandboxSpawnArgs('/b', 9222, '/p', '/e');
    expect(args).toContain('--disable-session-crashed-bubble');
    expect(args).toContain('--hide-crash-restore-bubble');
  });
});

describe('buildSandboxFlatpakArgs', () => {
  it('wraps the same sandbox flags in `flatpak run <app-id> --`', () => {
    const { cmd, args } = buildSandboxFlatpakArgs(
      'org.chromium.Chromium',
      9222,
      '/home/u/.pwa-debug/profiles/chromium',
      '/ext/dist',
    );
    expect(cmd).toBe('flatpak');
    expect(args).toEqual([
      'run',
      'org.chromium.Chromium',
      '--remote-debugging-port=9222',
      '--user-data-dir=/home/u/.pwa-debug/profiles/chromium',
      '--load-extension=/ext/dist',
      '--disable-extensions-except=/ext/dist',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
    ]);
    expect(args).not.toContain('--');
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
  it('pickExtensionPath returns the first loadable dir', () => {
    expect(
      pickExtensionPath(['/a', '/b', '/c'], (d) => d === '/b' || d === '/c'),
    ).toBe('/b');
  });
  it('pickExtensionPath returns null when none is loadable', () => {
    expect(pickExtensionPath(['/a', '/b'], () => false)).toBeNull();
  });
});

describe('isLoadableExtensionDir', () => {
  // A built/loadable extension dir: manifest.json AND content-script.js.
  const built = new Set([
    '/ext/dist/manifest.json',
    '/ext/dist/content-script.js',
  ]);
  // The extension SOURCE root: manifest.json present, no rollup output. This is
  // the dir the old picker wrongly chose, breaking the Chromium load.
  const sourceRoot = new Set(['/ext/src/manifest.json']);
  const exists = (set: Set<string>) => (p: string) => set.has(p);

  it('accepts a dir with manifest.json AND content-script.js', () => {
    expect(isLoadableExtensionDir('/ext/dist', exists(built))).toBe(true);
  });
  it('rejects the source root (manifest only, no built script)', () => {
    expect(isLoadableExtensionDir('/ext/src', exists(sourceRoot))).toBe(false);
  });
  it('rejects a dir missing the manifest', () => {
    expect(
      isLoadableExtensionDir('/ext/x', exists(new Set(['/ext/x/content-script.js']))),
    ).toBe(false);
  });
  it('via pickExtensionPath: skips the manifest-only source root for the built dist', () => {
    const candidates = ['/ext/src', '/ext/dist'];
    const all = new Set([...built, ...sourceRoot]);
    expect(
      pickExtensionPath(candidates, (d) => isLoadableExtensionDir(d, exists(all))),
    ).toBe('/ext/dist');
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
    manifestWrites: Array<{ userDataDir: string; snapPackage?: string }>;
  } => {
    const spawns: Array<{ cmd: string; args: readonly string[] }> = [];
    const registered: string[] = [];
    const manifestWrites: Array<{ userDataDir: string; snapPackage?: string }> = [];
    return {
      spawns,
      registered,
      manifestWrites,
      probeDebugPort: async () => opts.portLive ?? false,
      spawnBrowser: async (cmd, args) => {
        spawns.push({ cmd, args });
        return { pid: opts.pid ?? 555 };
      },
      registerTempProfile: (dir) => registered.push(dir),
      writeSandboxManifest: async (userDataDir, snapPackage) => {
        manifestWrites.push(
          snapPackage === undefined
            ? { userDataDir }
            : { userDataDir, snapPackage },
        );
      },
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
    // native sandbox finds the manifest at the default config dir — no per-profile write.
    expect(deps.manifestWrites).toHaveLength(0);
  });

  it('spawns a temp profile and registers it for cleanup', async () => {
    const deps = makeDeps({ portLive: false });
    const r = await launchSandbox({ ...input, mode: 'sandbox-temp' }, deps);
    expect(r.profileType).toBe('sandbox-temp');
    expect(deps.spawns).toHaveLength(1);
    expect(deps.registered).toEqual(['/h/.pwa-debug/profiles/chrome']);
  });

  it('spawns a flatpak sandbox via `flatpak run <app-id> --` when appId is set', async () => {
    const deps = makeDeps({ portLive: false });
    const r = await launchSandbox(
      {
        browser: 'chromium',
        execPath: 'org.chromium.Chromium',
        port: 9222,
        userDataDir: '/h/.pwa-debug/profiles/chromium',
        extensionPath: '/ext/dist',
        mode: 'sandbox-persistent',
        appId: 'org.chromium.Chromium',
      },
      deps,
    );
    expect(r.action).toBe('spawn-fresh');
    expect(deps.spawns[0]?.cmd).toBe('flatpak');
    expect(deps.spawns[0]?.args.slice(0, 2)).toEqual([
      'run',
      'org.chromium.Chromium',
    ]);
    expect(deps.spawns[0]?.args).toContain('--load-extension=/ext/dist');
    // 3a: flatpak writes the manifest (node launcher) into the sandbox profile.
    expect(deps.manifestWrites).toEqual([
      { userDataDir: '/h/.pwa-debug/profiles/chromium' },
    ]);
  });

  it('writes a snap-launcher manifest into the snap sandbox profile before spawn', async () => {
    const deps = makeDeps({ portLive: false });
    const r = await launchSandbox(
      {
        browser: 'chromium',
        execPath: '/snap/bin/chromium',
        port: 9222,
        userDataDir: '/h/snap/chromium/common/pwa-debug-profile',
        extensionPath: '/ext/dist',
        mode: 'sandbox-persistent',
        snapPackage: 'chromium',
      },
      deps,
    );
    expect(r.action).toBe('spawn-fresh');
    // snap spawns via execPath directly (NOT `flatpak run`)
    expect(deps.spawns[0]?.cmd).toBe('/snap/bin/chromium');
    // manifest written with the snap package so it points at the relay launcher
    expect(deps.manifestWrites).toEqual([
      {
        userDataDir: '/h/snap/chromium/common/pwa-debug-profile',
        snapPackage: 'chromium',
      },
    ]);
  });

  it('does NOT write a profile manifest when the flatpak port is already live (attach path)', async () => {
    const deps = makeDeps({ portLive: true });
    await launchSandbox(
      {
        browser: 'chromium',
        execPath: 'org.chromium.Chromium',
        port: 9222,
        userDataDir: '/h/.pwa-debug/profiles/chromium',
        extensionPath: '/ext/dist',
        mode: 'sandbox-persistent',
        appId: 'org.chromium.Chromium',
      },
      deps,
    );
    expect(deps.spawns).toHaveLength(0);
    expect(deps.manifestWrites).toHaveLength(0);
  });
});
