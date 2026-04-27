import { describe, it, expect } from 'vitest';
import { detectBrowserInstalls } from '../../src/native-messaging/browser_paths.js';

const makeExists = (truthy: readonly string[]) => {
  const set = new Set(truthy);
  const calls: string[] = [];
  const fn = async (p: string): Promise<boolean> => {
    calls.push(p);
    return set.has(p);
  };
  return Object.assign(fn, { calls });
};

describe('detectBrowserInstalls — linux', () => {
  it('detects native packages whose profile dir exists', async () => {
    const exists = makeExists([
      '/h/.config/google-chrome',
      '/h/.config/BraveSoftware/Brave-Browser',
    ]);
    const out = await detectBrowserInstalls({ HOME: '/h' }, 'linux', exists);
    expect(out.map((i) => ({ browser: i.browser, kind: i.kind }))).toEqual([
      { browser: 'chrome', kind: 'native' },
      { browser: 'brave', kind: 'native' },
    ]);
    const chrome = out.find((i) => i.browser === 'chrome');
    expect(chrome?.kind === 'native' ? chrome.manifestDir : null).toBe(
      '/h/.config/google-chrome/NativeMessagingHosts',
    );
  });

  it('uses XDG_CONFIG_HOME when set', async () => {
    const exists = makeExists(['/x/chromium']);
    const out = await detectBrowserInstalls({ XDG_CONFIG_HOME: '/x' }, 'linux', exists);
    expect(out).toHaveLength(1);
    expect(out[0]?.browser).toBe('chromium');
    expect(out[0]?.kind === 'native' ? out[0].manifestDir : null).toBe(
      '/x/chromium/NativeMessagingHosts',
    );
  });

  it('detects snap chromium under ~/snap/chromium/common/chromium', async () => {
    const exists = makeExists(['/h/snap/chromium/common/chromium']);
    const out = await detectBrowserInstalls({ HOME: '/h' }, 'linux', exists);
    expect(out).toHaveLength(1);
    expect(out[0]?.browser).toBe('chromium');
    expect(out[0]?.kind).toBe('snap');
    if (out[0]?.kind === 'snap') {
      expect(out[0].manifestDir).toBe('/h/snap/chromium/common/chromium/NativeMessagingHosts');
      expect(out[0].caveat).toMatch(/snap.*home interface/i);
    }
  });

  it('detects flatpak browsers under ~/.var/app/<id>', async () => {
    const exists = makeExists(['/h/.var/app/com.brave.Browser']);
    const out = await detectBrowserInstalls({ HOME: '/h' }, 'linux', exists);
    expect(out).toHaveLength(1);
    expect(out[0]?.browser).toBe('brave');
    expect(out[0]?.kind).toBe('flatpak');
    if (out[0]?.kind === 'flatpak') {
      expect(out[0].manifestDir).toBe(
        '/h/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
      );
      expect(out[0].caveat).toContain('flatpak override --user --filesystem=host com.brave.Browser');
    }
  });

  it('returns native + snap together when both exist', async () => {
    const exists = makeExists([
      '/h/.config/chromium',
      '/h/snap/chromium/common/chromium',
    ]);
    const out = await detectBrowserInstalls({ HOME: '/h' }, 'linux', exists);
    expect(out.map((i) => i.kind).sort()).toEqual(['native', 'snap']);
  });

  it('returns empty when no browser dir exists', async () => {
    const exists = makeExists([]);
    const out = await detectBrowserInstalls({ HOME: '/h' }, 'linux', exists);
    expect(out).toEqual([]);
  });

  it('throws when HOME and XDG_CONFIG_HOME both unset', async () => {
    await expect(detectBrowserInstalls({}, 'linux', makeExists([]))).rejects.toThrow(/config root/);
  });
});

describe('detectBrowserInstalls — darwin', () => {
  it('detects native browsers under ~/Library/Application Support', async () => {
    const exists = makeExists([
      '/h/Library/Application Support/Google/Chrome',
      '/h/Library/Application Support/Vivaldi',
    ]);
    const out = await detectBrowserInstalls({ HOME: '/h' }, 'darwin', exists);
    expect(out.map((i) => ({ browser: i.browser, kind: i.kind }))).toEqual([
      { browser: 'chrome', kind: 'native' },
      { browser: 'vivaldi', kind: 'native' },
    ]);
    const chrome = out.find((i) => i.browser === 'chrome');
    expect(chrome?.kind === 'native' ? chrome.manifestDir : null).toBe(
      '/h/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    );
  });

  it('throws when HOME unset on darwin', async () => {
    await expect(detectBrowserInstalls({}, 'darwin', makeExists([]))).rejects.toThrow(/HOME unset on darwin/);
  });
});

describe('detectBrowserInstalls — win32', () => {
  it('returns registry records for vendors whose %LOCALAPPDATA% user-data dir exists', async () => {
    const exists = makeExists([
      'C:\\Users\\u\\AppData\\Local/Google/Chrome/User Data',
      'C:\\Users\\u\\AppData\\Local/BraveSoftware/Brave-Browser/User Data',
    ]);
    const out = await detectBrowserInstalls(
      { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      'win32',
      exists,
    );
    expect(out).toHaveLength(2);
    const chrome = out.find((i) => i.browser === 'chrome');
    expect(chrome?.kind).toBe('registry');
    if (chrome?.kind === 'registry') {
      expect(chrome.registryHive).toBe('HKCU');
      expect(chrome.registrySubkey).toBe(
        'Software\\Google\\Chrome\\NativeMessagingHosts\\com.pwa_debug.host',
      );
    }
    const brave = out.find((i) => i.browser === 'brave');
    if (brave?.kind === 'registry') {
      expect(brave.registrySubkey).toBe(
        'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.pwa_debug.host',
      );
    }
  });

  it('falls back to USERPROFILE\\AppData\\Local when LOCALAPPDATA unset', async () => {
    const exists = makeExists(['C:\\Users\\u/AppData/Local/Microsoft/Edge/User Data']);
    const out = await detectBrowserInstalls(
      { USERPROFILE: 'C:\\Users\\u' },
      'win32',
      exists,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.browser).toBe('edge');
  });

  it('returns empty when neither LOCALAPPDATA nor USERPROFILE is set', async () => {
    const out = await detectBrowserInstalls({}, 'win32', makeExists([]));
    expect(out).toEqual([]);
  });
});

describe('detectBrowserInstalls — unsupported platforms', () => {
  it('returns empty without calling exists', async () => {
    const exists = makeExists([]);
    const out = await detectBrowserInstalls({ HOME: '/h' }, 'freebsd' as NodeJS.Platform, exists);
    expect(out).toEqual([]);
    expect(exists.calls).toEqual([]);
  });
});
