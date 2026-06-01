import { describe, it, expect } from 'vitest';
import {
  extensionLoadStrategy,
  parseBrowserVersion,
  readBrowserVersion,
} from '../../src/browser_launch/extension_load.js';

describe('parseBrowserVersion', () => {
  it('parses branded Google Chrome', () => {
    expect(parseBrowserVersion('Google Chrome 148.0.7778.215')).toEqual({
      brand: 'google-chrome',
      major: 148,
    });
  });

  it('parses Chrome for Testing as its own brand (not google-chrome)', () => {
    expect(
      parseBrowserVersion('Google Chrome for Testing 148.0.7778.215'),
    ).toEqual({ brand: 'chrome-for-testing', major: 148 });
  });

  it('parses Brave', () => {
    expect(parseBrowserVersion('Brave Browser 148.1.90.122')).toEqual({
      brand: 'brave',
      major: 148,
    });
  });

  it('parses Chromium (trailing channel word tolerated)', () => {
    expect(parseBrowserVersion('Chromium 148.0.7778.167 snap')).toEqual({
      brand: 'chromium',
      major: 148,
    });
  });

  it('parses Microsoft Edge', () => {
    expect(parseBrowserVersion('Microsoft Edge 141.0.3537.57')).toEqual({
      brand: 'edge',
      major: 141,
    });
  });

  it('parses Vivaldi and Opera', () => {
    expect(parseBrowserVersion('Vivaldi 6.5.3206.63')).toEqual({
      brand: 'vivaldi',
      major: 6,
    });
    expect(parseBrowserVersion('Opera 105.0.4970.21')).toEqual({
      brand: 'opera',
      major: 105,
    });
  });

  it('still parses an unrecognized product name as brand=unknown when a version is present', () => {
    expect(parseBrowserVersion('Weird Browser 99.0.1.2')).toEqual({
      brand: 'unknown',
      major: 99,
    });
  });

  it('trims surrounding whitespace/newlines', () => {
    expect(parseBrowserVersion('  Google Chrome 148.0.7778.215\n')).toEqual({
      brand: 'google-chrome',
      major: 148,
    });
  });

  it('returns null on empty or version-less output', () => {
    expect(parseBrowserVersion('')).toBeNull();
    expect(parseBrowserVersion('   ')).toBeNull();
    expect(parseBrowserVersion('no version here')).toBeNull();
  });
});

describe('extensionLoadStrategy', () => {
  it('null version → optimistic load-flag', () => {
    expect(extensionLoadStrategy(null)).toBe('load-flag');
  });

  it('non-Google Chromium always gets the plain flag', () => {
    expect(extensionLoadStrategy({ brand: 'brave', major: 148 })).toBe('load-flag');
    expect(extensionLoadStrategy({ brand: 'chromium', major: 148 })).toBe('load-flag');
    expect(extensionLoadStrategy({ brand: 'edge', major: 148 })).toBe('load-flag');
    // Chrome-for-Testing is NOT branded Google Chrome — flag works there too.
    expect(
      extensionLoadStrategy({ brand: 'chrome-for-testing', major: 148 }),
    ).toBe('load-flag');
    expect(extensionLoadStrategy({ brand: 'unknown', major: 142 })).toBe('load-flag');
  });

  it('branded Google Chrome bands on the major version', () => {
    expect(extensionLoadStrategy({ brand: 'google-chrome', major: 136 })).toBe('load-flag');
    expect(extensionLoadStrategy({ brand: 'google-chrome', major: 137 })).toBe('load-flag-escape-hatch');
    expect(extensionLoadStrategy({ brand: 'google-chrome', major: 141 })).toBe('load-flag-escape-hatch');
    expect(extensionLoadStrategy({ brand: 'google-chrome', major: 142 })).toBe('manual-guided');
    expect(extensionLoadStrategy({ brand: 'google-chrome', major: 148 })).toBe('manual-guided');
  });
});

describe('readBrowserVersion', () => {
  it('runs `<execPath> --version` for a native/snap target and parses it', async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const v = await readBrowserVersion(
      async (cmd, args) => {
        calls.push({ cmd, args });
        return { code: 0, stdout: 'Brave Browser 148.1.90.122' };
      },
      { execPath: '/usr/bin/brave-browser' },
    );
    expect(v).toEqual({ brand: 'brave', major: 148 });
    expect(calls).toEqual([
      { cmd: '/usr/bin/brave-browser', args: ['--version'] },
    ]);
  });

  it('runs `flatpak run <appId> --version` for a flatpak target', async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const v = await readBrowserVersion(
      async (cmd, args) => {
        calls.push({ cmd, args });
        return { code: 0, stdout: 'Chromium 148.0.7778.215' };
      },
      { execPath: 'org.chromium.Chromium', appId: 'org.chromium.Chromium' },
    );
    expect(v).toEqual({ brand: 'chromium', major: 148 });
    expect(calls).toEqual([
      { cmd: 'flatpak', args: ['run', 'org.chromium.Chromium', '--version'] },
    ]);
  });

  it('returns null on a non-zero exit', async () => {
    const v = await readBrowserVersion(
      async () => ({ code: 127, stdout: '' }),
      { execPath: '/usr/bin/nope' },
    );
    expect(v).toBeNull();
  });
});
