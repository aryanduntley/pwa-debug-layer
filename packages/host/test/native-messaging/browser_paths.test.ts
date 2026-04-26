import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSupportedBrowsers,
  manifestDirForBrowser,
  findInstalledBrowsers,
} from '../../src/native-messaging/browser_paths.js';

describe('listSupportedBrowsers', () => {
  it('returns the six Chromium-family browsers on Linux', () => {
    const list = listSupportedBrowsers('linux');
    expect(list.map((b) => b.name)).toEqual([
      'chrome',
      'chromium',
      'edge',
      'brave',
      'vivaldi',
      'opera',
    ]);
  });
  it('returns empty on unsupported platforms (M3 scope)', () => {
    expect(listSupportedBrowsers('darwin')).toEqual([]);
    expect(listSupportedBrowsers('win32')).toEqual([]);
  });
});

describe('manifestDirForBrowser', () => {
  const linuxBrowsers = listSupportedBrowsers('linux');
  const find = (name: string) => {
    const b = linuxBrowsers.find((x) => x.name === name);
    if (!b) throw new Error(`no ${name}`);
    return b;
  };

  it('uses XDG_CONFIG_HOME when set', () => {
    expect(manifestDirForBrowser(find('chrome'), { XDG_CONFIG_HOME: '/x' }, 'linux'))
      .toBe('/x/google-chrome/NativeMessagingHosts');
  });
  it('falls back to HOME/.config', () => {
    expect(manifestDirForBrowser(find('chromium'), { HOME: '/h' }, 'linux'))
      .toBe('/h/.config/chromium/NativeMessagingHosts');
  });
  it('handles multi-segment browser config dirs (Brave)', () => {
    expect(manifestDirForBrowser(find('brave'), { HOME: '/h' }, 'linux'))
      .toBe('/h/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts');
  });
  it('throws when neither HOME nor XDG_CONFIG_HOME is set', () => {
    expect(() => manifestDirForBrowser(find('chrome'), {}, 'linux')).toThrow(/config root/);
  });
  it('throws on unsupported platform', () => {
    expect(() => manifestDirForBrowser(find('chrome'), { HOME: '/h' }, 'darwin'))
      .toThrow(/not yet supported/);
  });
});

describe('findInstalledBrowsers', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pwa-debug-bp-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const realExists = async (p: string): Promise<boolean> => {
    try {
      const { stat } = await import('node:fs/promises');
      await stat(p);
      return true;
    } catch {
      return false;
    }
  };

  it('returns only browsers whose profile root exists on disk', async () => {
    await mkdir(join(dir, 'google-chrome'), { recursive: true });
    await mkdir(join(dir, 'BraveSoftware', 'Brave-Browser'), { recursive: true });
    const list = await findInstalledBrowsers({ XDG_CONFIG_HOME: dir }, 'linux', realExists);
    expect(list.map((b) => b.name).sort()).toEqual(['brave', 'chrome']);
    const chrome = list.find((b) => b.name === 'chrome');
    expect(chrome?.manifestDir).toBe(join(dir, 'google-chrome', 'NativeMessagingHosts'));
  });

  it('returns empty when no supported browser is installed', async () => {
    const list = await findInstalledBrowsers({ XDG_CONFIG_HOME: dir }, 'linux', realExists);
    expect(list).toEqual([]);
  });

  it('respects an injected exists stub for fully isolated tests', async () => {
    const seen: string[] = [];
    const fakeExists = async (p: string): Promise<boolean> => {
      seen.push(p);
      return p.endsWith('/microsoft-edge');
    };
    const list = await findInstalledBrowsers({ HOME: '/fake' }, 'linux', fakeExists);
    expect(list).toEqual([
      { name: 'edge', manifestDir: '/fake/.config/microsoft-edge/NativeMessagingHosts' },
    ]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('returns empty on unsupported platform without calling exists', async () => {
    let calls = 0;
    const list = await findInstalledBrowsers(
      { HOME: '/h' },
      'darwin',
      async () => {
        calls += 1;
        return true;
      },
    );
    expect(list).toEqual([]);
    expect(calls).toBe(0);
  });
});
