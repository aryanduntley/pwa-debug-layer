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
}): DiscoveryDeps & {
  whichCalls: string[];
  existsCalls: string[];
} => {
  const whichMap = opts.which ?? {};
  const existsSet = new Set(opts.exists ?? []);
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
    runCommand: async (): Promise<CommandResult> => ({ code: 1, stdout: '' }),
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
