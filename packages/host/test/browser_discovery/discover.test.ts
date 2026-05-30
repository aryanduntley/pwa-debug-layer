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
    // `opts.xdg` models the default-browser query (xdg-settings/defaults/reg).
    // `flatpak info` is a distinct command — no flatpak apps are installed in
    // these orchestration fixtures, so it must report not-found (code 1).
    runCommand: async (cmd: string): Promise<CommandResult> =>
      cmd === 'flatpak'
        ? { code: 1, stdout: '' }
        : (opts.xdg ?? { code: 1, stdout: '' }),
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

// macOS `defaults read … LSHandlers` is an old-style-plist array of dicts;
// the http/https rows carry the default handler bundle id. Keys within a dict
// appear in arbitrary order, which the parser must tolerate.
const LSHANDLERS_BRAVE = `(
        {
        LSHandlerContentType = "public.html";
        LSHandlerRoleAll = "com.brave.browser";
    },
        {
        LSHandlerRoleAll = "com.brave.browser";
        LSHandlerURLScheme = http;
    },
        {
        LSHandlerURLScheme = https;
        LSHandlerRoleAll = "com.brave.browser";
    }
)`;
const LSHANDLERS_FIREFOX = `(
        {
        LSHandlerRoleAll = "org.mozilla.firefox";
        LSHandlerURLScheme = http;
    }
)`;

describe('detectDefaultBrowser — darwin', () => {
  it('maps the http-scheme LSHandler bundle id to a browser', async () => {
    const deps = makeDeps({ xdg: { code: 0, stdout: LSHANDLERS_BRAVE } });
    expect(await detectDefaultBrowser('darwin', deps)).toBe('brave');
  });

  it('returns null for a non-Chromium default (firefox)', async () => {
    const deps = makeDeps({ xdg: { code: 0, stdout: LSHANDLERS_FIREFOX } });
    expect(await detectDefaultBrowser('darwin', deps)).toBeNull();
  });

  it('returns null when defaults read fails (no LaunchServices entry)', async () => {
    const deps = makeDeps({ xdg: { code: 1, stdout: '' } });
    expect(await detectDefaultBrowser('darwin', deps)).toBeNull();
  });
});

// Windows `reg query … /v ProgId` prints a header line then an indented value
// line: `    ProgId    REG_SZ    <ProgId>`.
const regOut = (progId: string): string =>
  `\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ${progId}\r\n`;

describe('detectDefaultBrowser — win32', () => {
  it('maps a ChromeHTML ProgId to chrome', async () => {
    const deps = makeDeps({ xdg: { code: 0, stdout: regOut('ChromeHTML') } });
    expect(await detectDefaultBrowser('win32', deps)).toBe('chrome');
  });

  it('maps ChromiumHTM to chromium (not swallowed by the chrome test)', async () => {
    const deps = makeDeps({ xdg: { code: 0, stdout: regOut('ChromiumHTM') } });
    expect(await detectDefaultBrowser('win32', deps)).toBe('chromium');
  });

  it('maps MSEdgeHTM to edge and a hashed BraveSSHTML to brave', async () => {
    expect(
      await detectDefaultBrowser(
        'win32',
        makeDeps({ xdg: { code: 0, stdout: regOut('MSEdgeHTM') } }),
      ),
    ).toBe('edge');
    expect(
      await detectDefaultBrowser(
        'win32',
        makeDeps({ xdg: { code: 0, stdout: regOut('BraveSSHTML.A1B2C3') } }),
      ),
    ).toBe('brave');
  });

  it('returns null for a non-Chromium default (FirefoxURL)', async () => {
    const deps = makeDeps({ xdg: { code: 0, stdout: regOut('FirefoxURL') } });
    expect(await detectDefaultBrowser('win32', deps)).toBeNull();
  });

  it('returns null when the registry query fails', async () => {
    const deps = makeDeps({ xdg: { code: 1, stdout: '' } });
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
