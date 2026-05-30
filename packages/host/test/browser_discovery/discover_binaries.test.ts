import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { discoverBinaries } from '../../src/browser_discovery/discover_binaries.js';
import type {
  CommandResult,
  DiscoveryDeps,
} from '../../src/browser_discovery/types.js';

/** Build DiscoveryDeps from explicit which/exists maps; records all probes. */
const makeDeps = (opts: {
  which?: Readonly<Record<string, string>>;
  exists?: readonly string[];
  /** flatpak app-ids for which `flatpak info <id>` should exit 0 (installed). */
  flatpakApps?: readonly string[];
}): DiscoveryDeps & {
  whichCalls: string[];
  existsCalls: string[];
} => {
  const whichMap = opts.which ?? {};
  const existsSet = new Set(opts.exists ?? []);
  const flatpakSet = new Set(opts.flatpakApps ?? []);
  const whichCalls: string[] = [];
  const existsCalls: string[] = [];
  return {
    whichCalls,
    existsCalls,
    which: async (name: string) => {
      whichCalls.push(name);
      return whichMap[name] ?? null;
    },
    fileExists: async (p: string) => {
      existsCalls.push(p);
      return existsSet.has(p);
    },
    runCommand: async (
      cmd: string,
      args: readonly string[],
    ): Promise<CommandResult> => {
      // Model `flatpak info <app-id>`: exit 0 when the app-id is installed.
      if (cmd === 'flatpak' && args[0] === 'info' && flatpakSet.has(args[1] ?? '')) {
        return { code: 0, stdout: '' };
      }
      return { code: 1, stdout: '' };
    },
  };
};

describe('discoverBinaries — linux', () => {
  it('prefers a PATH hit and tags source=path', async () => {
    const deps = makeDeps({ which: { 'google-chrome': '/usr/bin/google-chrome' } });
    const out = await discoverBinaries('linux', {}, deps);
    expect(out).toEqual([
      {
        browser: 'chrome',
        execPath: '/usr/bin/google-chrome',
        source: 'path',
        packaging: 'native',
        isDefault: false,
      },
    ]);
    // Stops probing further PATH names for that browser after first hit.
    expect(deps.whichCalls).toContain('google-chrome');
    expect(deps.whichCalls).not.toContain('google-chrome-stable');
  });

  it('falls back to a standard absolute path when PATH misses', async () => {
    const deps = makeDeps({ exists: ['/opt/brave.com/brave/brave-browser'] });
    const out = await discoverBinaries('linux', {}, deps);
    expect(out).toEqual([
      {
        browser: 'brave',
        execPath: '/opt/brave.com/brave/brave-browser',
        source: 'standard-path',
        packaging: 'native',
        isDefault: false,
      },
    ]);
  });

  it('tags packaging=snap when the standard path is under /snap/', async () => {
    // chromium's standardPaths include /snap/bin/chromium; a /snap/ exec is
    // snap-confined (different profile root), so packaging must say so.
    const deps = makeDeps({ exists: ['/snap/bin/chromium'] });
    const out = await discoverBinaries('linux', {}, deps);
    expect(out).toEqual([
      {
        browser: 'chromium',
        execPath: '/snap/bin/chromium',
        source: 'standard-path',
        packaging: 'snap',
        isDefault: false,
      },
    ]);
  });

  it('returns empty when nothing is installed', async () => {
    const out = await discoverBinaries('linux', {}, makeDeps({}));
    expect(out).toEqual([]);
  });

  it('detects multiple browsers, one row per browser', async () => {
    const deps = makeDeps({
      which: {
        'google-chrome': '/usr/bin/google-chrome',
        chromium: '/usr/bin/chromium',
      },
      exists: ['/opt/microsoft/msedge/msedge'],
    });
    const out = await discoverBinaries('linux', {}, deps);
    expect(out.map((b) => b.browser)).toEqual(['chrome', 'chromium', 'edge']);
    expect(out.find((b) => b.browser === 'edge')?.source).toBe('standard-path');
  });
});

describe('discoverBinaries — linux flatpak', () => {
  it('surfaces an installed flatpak app with source=flatpak + app-id in execPath and appId', async () => {
    const deps = makeDeps({ flatpakApps: ['org.chromium.Chromium'] });
    const out = await discoverBinaries('linux', {}, deps);
    expect(out).toEqual([
      {
        browser: 'chromium',
        execPath: 'org.chromium.Chromium',
        source: 'flatpak',
        packaging: 'flatpak',
        isDefault: false,
        appId: 'org.chromium.Chromium',
      },
    ]);
  });

  it('omits flatpak apps that are not installed', async () => {
    const out = await discoverBinaries('linux', {}, makeDeps({}));
    expect(out).toEqual([]);
  });

  it('appends flatpak AFTER native so first-match prefers the native install', async () => {
    const deps = makeDeps({
      which: { chromium: '/usr/bin/chromium' },
      flatpakApps: ['org.chromium.Chromium'],
    });
    const out = await discoverBinaries('linux', {}, deps);
    // Both surface, native first → orchestrator's .find() picks native.
    expect(out.map((b) => b.source)).toEqual(['path', 'flatpak']);
    expect(out.filter((b) => b.browser === 'chromium')).toHaveLength(2);
  });
});

describe('discoverBinaries — darwin (best-effort)', () => {
  it('detects a browser by its .app exec path', async () => {
    const deps = makeDeps({
      exists: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    });
    const out = await discoverBinaries('darwin', {}, deps);
    expect(out).toEqual([
      {
        browser: 'chrome',
        execPath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        source: 'standard-path',
        packaging: 'native',
        isDefault: false,
      },
    ]);
  });
});

describe('discoverBinaries — win32 (best-effort)', () => {
  it('joins table segments onto each Program Files root', async () => {
    const root = 'C:\\Program Files';
    // join() uses the test runner's separator; build the expectation the same way.
    const exe = join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
    const deps = makeDeps({ exists: [exe] });
    const out = await discoverBinaries('win32', { PROGRAMFILES: root }, deps);
    expect(out).toEqual([
      {
        browser: 'chrome',
        execPath: exe,
        source: 'standard-path',
        packaging: 'native',
        isDefault: false,
      },
    ]);
  });

  it('returns empty when no Program Files roots are present', async () => {
    const out = await discoverBinaries('win32', {}, makeDeps({}));
    expect(out).toEqual([]);
  });
});

describe('discoverBinaries — unknown platform', () => {
  it('returns empty without throwing', async () => {
    const out = await discoverBinaries(
      'freebsd' as NodeJS.Platform,
      {},
      makeDeps({}),
    );
    expect(out).toEqual([]);
  });
});
