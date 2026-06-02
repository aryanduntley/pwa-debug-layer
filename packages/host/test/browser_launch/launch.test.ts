import { describe, it, expect } from 'vitest';
import {
  classifyRunState,
  chooseLaunchAction,
} from '../../src/browser_launch/run_state.js';
import {
  browserUrlFor,
  buildFreshFlatpakArgs,
  buildFreshSpawnArgs,
  buildNewWindowArgs,
  buildNewWindowFlatpakArgs,
} from '../../src/browser_launch/spawn_args.js';
import { defaultUserDataDir } from '../../src/browser_launch/profile_dirs.js';
import { launchExisting } from '../../src/browser_launch/launch_existing.js';
import type {
  LaunchDeps,
  SpawnOutcome,
} from '../../src/browser_launch/types.js';

/** LaunchDeps fake with configurable probe/process results; records spawns. */
const makeDeps = (opts: {
  portLive?: boolean;
  processRunning?: boolean;
  pid?: number | null;
}): LaunchDeps & { spawns: Array<{ cmd: string; args: readonly string[] }> } => {
  const spawns: Array<{ cmd: string; args: readonly string[] }> = [];
  return {
    spawns,
    probeDebugPort: async () => opts.portLive ?? false,
    isProcessRunning: async () => opts.processRunning ?? false,
    spawnBrowser: async (cmd, args): Promise<SpawnOutcome> => {
      spawns.push({ cmd, args });
      return { pid: opts.pid ?? 4242 };
    },
  };
};

describe('classifyRunState', () => {
  it('port-live wins regardless of process flag', () => {
    expect(classifyRunState(true, false)).toBe('port-live');
    expect(classifyRunState(true, true)).toBe('port-live');
  });
  it('running-no-port when process up but no port', () => {
    expect(classifyRunState(false, true)).toBe('running-no-port');
  });
  it('not-running when neither', () => {
    expect(classifyRunState(false, false)).toBe('not-running');
  });
});

describe('chooseLaunchAction', () => {
  it('maps each run state to its action', () => {
    expect(chooseLaunchAction('port-live')).toBe('attach');
    expect(chooseLaunchAction('running-no-port')).toBe('new-window');
    expect(chooseLaunchAction('not-running')).toBe('spawn-fresh');
  });
});

describe('spawn_args builders', () => {
  it('browserUrlFor formats the CDP endpoint', () => {
    expect(browserUrlFor(9222)).toBe('http://127.0.0.1:9222');
  });
  it('buildFreshSpawnArgs sets debug port + user-data-dir + non-interactive flags', () => {
    const { cmd, args } = buildFreshSpawnArgs(
      '/usr/bin/google-chrome',
      9222,
      '/home/u/.config/google-chrome',
    );
    expect(cmd).toBe('/usr/bin/google-chrome');
    expect(args).toEqual([
      '--remote-debugging-port=9222',
      '--user-data-dir=/home/u/.config/google-chrome',
      '--no-first-run',
      '--no-default-browser-check',
    ]);
  });
  it('buildNewWindowArgs only opens a new window (no debug port)', () => {
    const { cmd, args } = buildNewWindowArgs('/usr/bin/brave-browser');
    expect(cmd).toBe('/usr/bin/brave-browser');
    expect(args).toEqual(['--new-window']);
  });
  it('buildFreshFlatpakArgs prefixes `flatpak run <app-id>` with NO `--` (chrome would eat it)', () => {
    const { cmd, args } = buildFreshFlatpakArgs(
      'org.chromium.Chromium',
      9222,
      '/h/.var/app/org.chromium.Chromium/config/chromium',
    );
    expect(cmd).toBe('flatpak');
    expect(args).toEqual([
      'run',
      'org.chromium.Chromium',
      '--remote-debugging-port=9222',
      '--user-data-dir=/h/.var/app/org.chromium.Chromium/config/chromium',
      '--no-first-run',
      '--no-default-browser-check',
    ]);
    // A literal '--' would become chrome's end-of-switches marker and drop the port.
    expect(args).not.toContain('--');
  });
  it('buildNewWindowFlatpakArgs is `flatpak run <app-id> --new-window` (no `--`)', () => {
    const { cmd, args } = buildNewWindowFlatpakArgs('org.chromium.Chromium');
    expect(cmd).toBe('flatpak');
    expect(args).toEqual(['run', 'org.chromium.Chromium', '--new-window']);
  });
});

describe('defaultUserDataDir', () => {
  it('resolves Linux native profile under XDG_CONFIG_HOME', () => {
    expect(defaultUserDataDir('chrome', 'linux', { XDG_CONFIG_HOME: '/c' })).toBe(
      '/c/google-chrome',
    );
    expect(defaultUserDataDir('brave', 'linux', { HOME: '/h' })).toBe(
      '/h/.config/BraveSoftware/Brave-Browser',
    );
  });
  it('returns null on Linux when no config root is resolvable', () => {
    expect(defaultUserDataDir('chrome', 'linux', {})).toBeNull();
  });
  it('resolves the snap confined profile when execPath is under /snap/', () => {
    // snap chromium stores its profile at ~/snap/chromium/common/chromium,
    // NOT ~/.config/chromium — the native path would point at an empty dir.
    expect(
      defaultUserDataDir('chromium', 'linux', { HOME: '/h' }, '/snap/bin/chromium'),
    ).toBe('/h/snap/chromium/common/chromium');
  });
  it('ignores XDG_CONFIG_HOME for snap (confinement is HOME-based)', () => {
    expect(
      defaultUserDataDir(
        'chromium',
        'linux',
        { HOME: '/h', XDG_CONFIG_HOME: '/c' },
        '/snap/bin/chromium',
      ),
    ).toBe('/h/snap/chromium/common/chromium');
  });
  it('degrades to null for a snap exec of a browser not in the snap table', () => {
    expect(
      defaultUserDataDir('opera', 'linux', { HOME: '/h' }, '/snap/bin/opera'),
    ).toBeNull();
  });
  it('uses the native path when execPath is a normal /usr/bin install', () => {
    expect(
      defaultUserDataDir('chromium', 'linux', { HOME: '/h' }, '/usr/bin/chromium'),
    ).toBe('/h/.config/chromium');
  });
  it('resolves the flatpak profile when execPath is a slash-free app-id', () => {
    // flatpak chromium stores its profile at ~/.var/app/<app-id>/config/chromium.
    expect(
      defaultUserDataDir(
        'chromium',
        'linux',
        { HOME: '/h' },
        'org.chromium.Chromium',
      ),
    ).toBe('/h/.var/app/org.chromium.Chromium/config/chromium');
  });
  it('ignores XDG_CONFIG_HOME for flatpak (profile is ~/.var/app based)', () => {
    expect(
      defaultUserDataDir(
        'chromium',
        'linux',
        { HOME: '/h', XDG_CONFIG_HOME: '/c' },
        'org.chromium.Chromium',
      ),
    ).toBe('/h/.var/app/org.chromium.Chromium/config/chromium');
  });
  it('degrades to null for an unknown flatpak app-id', () => {
    expect(
      defaultUserDataDir('chromium', 'linux', { HOME: '/h' }, 'com.unknown.App'),
    ).toBeNull();
  });
  it('resolves best-effort macOS + Windows paths from env', () => {
    expect(defaultUserDataDir('chrome', 'darwin', { HOME: '/Users/u' })).toBe(
      '/Users/u/Library/Application Support/Google/Chrome',
    );
    expect(
      defaultUserDataDir('edge', 'win32', { LOCALAPPDATA: '/L' }),
    ).toBe('/L/Microsoft/Edge/User Data');
  });
  it('returns null for unsupported platform', () => {
    expect(
      defaultUserDataDir('chrome', 'freebsd' as NodeJS.Platform, { HOME: '/h' }),
    ).toBeNull();
  });
});

describe('launchExisting — triad', () => {
  const input = {
    browser: 'chrome' as const,
    execPath: '/usr/bin/google-chrome',
    port: 9222,
    userDataDir: '/h/.config/google-chrome',
    debugPortBlockedOnDefaultProfile: false,
  };

  it('(a) attaches when the debug port is live — no spawn', async () => {
    const deps = makeDeps({ portLive: true });
    const r = await launchExisting(input, deps);
    expect(r).toMatchObject({
      action: 'attach',
      attached: true,
      profileType: 'existing',
      browserUrl: 'http://127.0.0.1:9222',
      pid: null,
    });
    expect(r.degradation).toBeUndefined();
    expect(deps.spawns).toHaveLength(0);
  });

  it('(b) opens a new window when running without a port — degraded', async () => {
    const deps = makeDeps({ portLive: false, processRunning: true });
    const r = await launchExisting(input, deps);
    expect(r).toMatchObject({
      action: 'new-window',
      attached: false,
      browserUrl: null,
      pid: 4242,
    });
    expect(r.degradation).toContain('chrome-devtools-mcp');
    expect(deps.spawns).toEqual([
      { cmd: '/usr/bin/google-chrome', args: ['--new-window'] },
    ]);
  });

  it('(c) spawns fresh with the debug port when not running', async () => {
    const deps = makeDeps({ portLive: false, processRunning: false });
    const r = await launchExisting(input, deps);
    expect(r).toMatchObject({
      action: 'spawn-fresh',
      attached: true,
      browserUrl: 'http://127.0.0.1:9222',
      pid: 4242,
    });
    expect(r.degradation).toBeUndefined();
    expect(deps.spawns).toEqual([
      {
        cmd: '/usr/bin/google-chrome',
        args: [
          '--remote-debugging-port=9222',
          '--user-data-dir=/h/.config/google-chrome',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      },
    ]);
  });

  it('(c, Chromium 136+) spawns fresh but degrades — no usable debug port on the default profile', async () => {
    const deps = makeDeps({ portLive: false, processRunning: false });
    const r = await launchExisting(
      { ...input, debugPortBlockedOnDefaultProfile: true },
      deps,
    );
    expect(r).toMatchObject({
      action: 'spawn-fresh',
      attached: false,
      browserUrl: null,
      pid: 4242,
    });
    expect(r.degradation).toContain('DEFAULT profile');
    expect(r.degradation).toContain('sandbox-persistent');
    // the browser is still spawned (pwa-debug extension usable) — only the port is unavailable
    expect(deps.spawns).toHaveLength(1);
  });

  it('does not consult isProcessRunning when the port is already live', async () => {
    let processChecked = false;
    const deps: LaunchDeps = {
      probeDebugPort: async () => true,
      isProcessRunning: async () => {
        processChecked = true;
        return true;
      },
      spawnBrowser: async () => ({ pid: null }),
    };
    await launchExisting(input, deps);
    expect(processChecked).toBe(false);
  });
});

describe('launchExisting — flatpak (appId set → `flatpak run` spawn form)', () => {
  // For a flatpak target, execPath is the app-id and appId is set; spawns must
  // go through `flatpak run <app-id> -- …`, never exec-by-path.
  const input = {
    browser: 'chromium' as const,
    execPath: 'org.chromium.Chromium',
    port: 9222,
    userDataDir: '/h/.var/app/org.chromium.Chromium/config/chromium',
    appId: 'org.chromium.Chromium',
  };

  it('(b) opens a new window via `flatpak run <app-id> -- --new-window`', async () => {
    const deps = makeDeps({ portLive: false, processRunning: true });
    const r = await launchExisting(input, deps);
    expect(r.action).toBe('new-window');
    expect(deps.spawns).toEqual([
      {
        cmd: 'flatpak',
        args: ['run', 'org.chromium.Chromium', '--new-window'],
      },
    ]);
  });

  it('(c) spawns fresh via `flatpak run <app-id> <fresh flags>`', async () => {
    const deps = makeDeps({ portLive: false, processRunning: false });
    const r = await launchExisting(input, deps);
    expect(r.action).toBe('spawn-fresh');
    expect(deps.spawns).toEqual([
      {
        cmd: 'flatpak',
        args: [
          'run',
          'org.chromium.Chromium',
          '--remote-debugging-port=9222',
          '--user-data-dir=/h/.var/app/org.chromium.Chromium/config/chromium',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      },
    ]);
  });
});
