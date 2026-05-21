import { describe, it, expect } from 'vitest';
import {
  launchBrowserCore,
  type LaunchBrowserCoreDeps,
} from '../../../src/mcp/tools/launch_browser.js';
import type { BrowserDiscoveryResult } from '../../../src/browser_discovery/types.js';
import type {
  LaunchExistingInput,
  LaunchResult,
  LaunchSandboxInput,
} from '../../../src/browser_launch/types.js';

const discovery = (
  browsers: BrowserDiscoveryResult['browsers'],
  defaultBrowser: BrowserDiscoveryResult['defaultBrowser'],
): BrowserDiscoveryResult =>
  Object.freeze({ platform: 'linux', browsers, defaultBrowser });

/** Core deps fake; records the inputs each launch path was given. */
const makeDeps = (opts: {
  discovery: BrowserDiscoveryResult;
  userDataDir?: string | null;
  sandboxDir?: string | null;
  extensionPath?: string | null;
  result?: Partial<LaunchResult>;
}): LaunchBrowserCoreDeps & {
  launched: LaunchExistingInput[];
  sandboxed: LaunchSandboxInput[];
  recorded: Array<{ port: number; browser: string }>;
} => {
  const launched: LaunchExistingInput[] = [];
  const sandboxed: LaunchSandboxInput[] = [];
  const recorded: Array<{ port: number; browser: string }> = [];
  return {
    launched,
    sandboxed,
    recorded,
    recordLaunch: (result, port) =>
      recorded.push({ port, browser: result.browser }),
    discover: async () => opts.discovery,
    resolveUserDataDir: () =>
      opts.userDataDir === undefined ? '/h/.config/google-chrome' : opts.userDataDir,
    launch: async (input) => {
      launched.push(input);
      return Object.freeze({
        ok: true,
        browser: input.browser,
        browserUrl: 'http://127.0.0.1:9222',
        profileType: 'existing',
        attached: true,
        action: 'spawn-fresh',
        pid: 99,
        ...opts.result,
      });
    },
    resolveSandboxProfileDir: (browser, mode) =>
      opts.sandboxDir === undefined
        ? `/h/.pwa-debug/profiles/${browser}-${mode}`
        : opts.sandboxDir,
    resolveExtensionPath: () =>
      opts.extensionPath === undefined ? '/ext/dist' : opts.extensionPath,
    launchSandbox: async (input) => {
      sandboxed.push(input);
      return Object.freeze({
        ok: true,
        browser: input.browser,
        browserUrl: 'http://127.0.0.1:9222',
        profileType: input.mode,
        attached: true,
        action: 'spawn-fresh',
        pid: 77,
        userDataDir: input.userDataDir,
        ...opts.result,
      });
    },
  };
};

const chrome = Object.freeze({
  browser: 'chrome' as const,
  execPath: '/usr/bin/google-chrome',
  source: 'path' as const,
  isDefault: true,
});
const brave = Object.freeze({
  browser: 'brave' as const,
  execPath: '/usr/bin/brave-browser',
  source: 'path' as const,
  isDefault: false,
});

describe('launchBrowserCore', () => {
  it('launches the system-default browser when none requested', async () => {
    const deps = makeDeps({ discovery: discovery([chrome, brave], 'chrome') });
    const res = await launchBrowserCore({}, 'linux', {}, deps);
    expect(res.ok).toBe(true);
    expect(deps.launched[0]).toMatchObject({
      browser: 'chrome',
      execPath: '/usr/bin/google-chrome',
      port: 9222,
      userDataDir: '/h/.config/google-chrome',
    });
    expect(deps.recorded).toEqual([{ port: 9222, browser: 'chrome' }]);
  });

  it('honours an explicit browser request', async () => {
    const deps = makeDeps({ discovery: discovery([chrome, brave], 'chrome') });
    await launchBrowserCore({ browser: 'brave' }, 'linux', {}, deps);
    expect(deps.launched[0]?.browser).toBe('brave');
  });

  it('passes a custom port through', async () => {
    const deps = makeDeps({ discovery: discovery([chrome], 'chrome') });
    await launchBrowserCore({ port: 9333 }, 'linux', {}, deps);
    expect(deps.launched[0]?.port).toBe(9333);
  });

  it('errors when the requested browser is not installed', async () => {
    const deps = makeDeps({ discovery: discovery([chrome], 'chrome') });
    const res = await launchBrowserCore({ browser: 'edge' }, 'linux', {}, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("'edge'");
    expect(deps.launched).toHaveLength(0);
  });

  it('errors when no browser is detected at all', async () => {
    const deps = makeDeps({ discovery: discovery([], null) });
    const res = await launchBrowserCore({}, 'linux', {}, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No Chromium-family browser');
  });

  it('errors when the user-data-dir cannot be resolved', async () => {
    const deps = makeDeps({
      discovery: discovery([chrome], 'chrome'),
      userDataDir: null,
    });
    const res = await launchBrowserCore({}, 'linux', {}, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('user-data-dir');
  });

  it('surfaces the degradation message in next_steps for new-window', async () => {
    const deps = makeDeps({
      discovery: discovery([chrome], 'chrome'),
      result: {
        action: 'new-window',
        attached: false,
        browserUrl: null,
        degradation: 'CDP unavailable — restart to enable.',
      },
    });
    const res = await launchBrowserCore({}, 'linux', {}, deps);
    expect(res.ok).toBe(true);
    expect(res.next_steps[0]).toContain('CDP unavailable');
  });

  it('includes the chrome-devtools-mcp registration snippet on attach', async () => {
    const deps = makeDeps({
      discovery: discovery([chrome], 'chrome'),
      result: { action: 'attach', attached: true, pid: null },
    });
    const res = await launchBrowserCore({}, 'linux', {}, deps);
    expect(res.next_steps[0]).toContain('claude mcp add chrome-devtools');
    expect(res.next_steps[0]).toContain('http://127.0.0.1:9222');
  });

  it('returns a discovery-failure error when discover throws', async () => {
    const deps: LaunchBrowserCoreDeps = {
      discover: async () => {
        throw new Error('boom');
      },
      resolveUserDataDir: () => '/x',
      launch: async () => {
        throw new Error('should not reach');
      },
      resolveSandboxProfileDir: () => '/x',
      resolveExtensionPath: () => '/x',
      launchSandbox: async () => {
        throw new Error('should not reach');
      },
      recordLaunch: () => {},
    };
    const res = await launchBrowserCore({}, 'linux', {}, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('discovery failed');
  });
});

describe('launchBrowserCore — sandbox modes', () => {
  it('routes sandbox-persistent through launchSandbox with the resolved dir + extension', async () => {
    const deps = makeDeps({ discovery: discovery([chrome], 'chrome') });
    const res = await launchBrowserCore(
      { mode: 'sandbox-persistent' },
      'linux',
      {},
      deps,
    );
    expect(res.ok).toBe(true);
    expect(deps.launched).toHaveLength(0);
    expect(deps.sandboxed[0]).toMatchObject({
      browser: 'chrome',
      execPath: '/usr/bin/google-chrome',
      port: 9222,
      userDataDir: '/h/.pwa-debug/profiles/chrome-sandbox-persistent',
      extensionPath: '/ext/dist',
      mode: 'sandbox-persistent',
    });
    expect(res.next_steps.join(' ')).toContain('preloaded');
  });

  it('routes sandbox-temp through launchSandbox', async () => {
    const deps = makeDeps({ discovery: discovery([brave], 'brave') });
    await launchBrowserCore(
      { browser: 'brave', mode: 'sandbox-temp' },
      'linux',
      {},
      deps,
    );
    expect(deps.sandboxed[0]?.mode).toBe('sandbox-temp');
    expect(deps.sandboxed[0]?.browser).toBe('brave');
  });

  it('errors when the sandbox profile dir cannot be resolved', async () => {
    const deps = makeDeps({
      discovery: discovery([chrome], 'chrome'),
      sandboxDir: null,
    });
    const res = await launchBrowserCore(
      { mode: 'sandbox-persistent' },
      'linux',
      {},
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('profile dir');
    expect(deps.sandboxed).toHaveLength(0);
  });

  it('errors with build/install guidance when the extension is missing', async () => {
    const deps = makeDeps({
      discovery: discovery([chrome], 'chrome'),
      extensionPath: null,
    });
    const res = await launchBrowserCore(
      { mode: 'sandbox-temp' },
      'linux',
      {},
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('pwa-debug extension');
    expect(res.next_steps.join(' ')).toContain('PWA_DEBUG_EXTENSION_PATH');
    expect(deps.sandboxed).toHaveLength(0);
  });
});
