import { describe, it, expect } from 'vitest';
import { detectDefaultBrowser } from '../../src/browser_discovery/default_browser.js';
import { discoverBrowsers } from '../../src/browser_discovery/discover.js';
import type {
  CommandResult,
  DiscoveryDeps,
} from '../../src/browser_discovery/types.js';

/** Deps whose runCommand returns a fixed xdg-settings result; which/exists configurable. */
const makeDeps = (opts: {
  xdg?: CommandResult;
  which?: Readonly<Record<string, string>>;
  exists?: readonly string[];
}): DiscoveryDeps => {
  const whichMap = opts.which ?? {};
  const existsSet = new Set(opts.exists ?? []);
  return {
    which: async (name: string) => whichMap[name] ?? null,
    fileExists: async (p: string) => existsSet.has(p),
    runCommand: async (): Promise<CommandResult> =>
      opts.xdg ?? { code: 1, stdout: '' },
  };
};

describe('detectDefaultBrowser — linux', () => {
  it('maps a chrome .desktop id to chrome', async () => {
    const deps = makeDeps({ xdg: { code: 0, stdout: 'google-chrome.desktop\n' } });
    expect(await detectDefaultBrowser('linux', deps)).toBe('chrome');
  });

  it('maps brave + chromium .desktop ids', async () => {
    expect(
      await detectDefaultBrowser(
        'linux',
        makeDeps({ xdg: { code: 0, stdout: 'brave-browser.desktop' } }),
      ),
    ).toBe('brave');
    expect(
      await detectDefaultBrowser(
        'linux',
        makeDeps({ xdg: { code: 0, stdout: 'chromium_chromium.desktop' } }),
      ),
    ).toBe('chromium');
  });

  it('returns null for a non-Chromium default (firefox)', async () => {
    const deps = makeDeps({ xdg: { code: 0, stdout: 'firefox.desktop' } });
    expect(await detectDefaultBrowser('linux', deps)).toBeNull();
  });

  it('returns null when xdg-settings fails (missing binary / non-zero exit)', async () => {
    const deps = makeDeps({ xdg: { code: 127, stdout: '' } });
    expect(await detectDefaultBrowser('linux', deps)).toBeNull();
  });
});

describe('detectDefaultBrowser — deferred platforms', () => {
  it('returns null on darwin and win32', async () => {
    const deps = makeDeps({ xdg: { code: 0, stdout: 'google-chrome.desktop' } });
    expect(await detectDefaultBrowser('darwin', deps)).toBeNull();
    expect(await detectDefaultBrowser('win32', deps)).toBeNull();
  });
});

describe('discoverBrowsers — orchestration', () => {
  it('marks isDefault on the matching located browser', async () => {
    const deps = makeDeps({
      which: {
        'google-chrome': '/usr/bin/google-chrome',
        chromium: '/usr/bin/chromium',
      },
      xdg: { code: 0, stdout: 'chromium-browser.desktop' },
    });
    const res = await discoverBrowsers('linux', {}, deps);
    expect(res.defaultBrowser).toBe('chromium');
    expect(res.browsers.find((b) => b.browser === 'chromium')?.isDefault).toBe(
      true,
    );
    expect(res.browsers.find((b) => b.browser === 'chrome')?.isDefault).toBe(
      false,
    );
  });

  it('leaves all isDefault false when the default is not installed', async () => {
    const deps = makeDeps({
      which: { 'google-chrome': '/usr/bin/google-chrome' },
      xdg: { code: 0, stdout: 'vivaldi-stable.desktop' },
    });
    const res = await discoverBrowsers('linux', {}, deps);
    expect(res.defaultBrowser).toBe('vivaldi');
    expect(res.browsers.every((b) => !b.isDefault)).toBe(true);
  });

  it('reports defaultBrowser=null when detection yields nothing', async () => {
    const deps = makeDeps({
      which: { 'google-chrome': '/usr/bin/google-chrome' },
      xdg: { code: 1, stdout: '' },
    });
    const res = await discoverBrowsers('linux', {}, deps);
    expect(res.defaultBrowser).toBeNull();
    expect(res.browsers).toHaveLength(1);
    expect(res.browsers[0]?.isDefault).toBe(false);
  });
});
