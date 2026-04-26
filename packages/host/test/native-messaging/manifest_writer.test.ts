import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHostManifest,
  writeHostManifestForBrowsers,
  removeHostManifestForBrowsers,
} from '../../src/native-messaging/manifest_writer.js';
import type { InstalledBrowser } from '../../src/native-messaging/browser_paths.js';

const fakeBrowsers = (root: string): readonly InstalledBrowser[] =>
  Object.freeze([
    { name: 'chrome', manifestDir: join(root, 'google-chrome', 'NativeMessagingHosts') },
    { name: 'brave', manifestDir: join(root, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
  ]);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-mw-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildHostManifest', () => {
  it('produces the expected shape', () => {
    const m = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'desc',
      hostBinaryPath: '/abs/host',
      allowedExtensionIds: ['abcdef'],
    });
    expect(m).toEqual({
      name: 'com.pwa_debug.host',
      description: 'desc',
      path: '/abs/host',
      type: 'stdio',
      allowed_origins: ['chrome-extension://abcdef/'],
    });
  });

  it('dedupes and sorts allowed_origins', () => {
    const m = buildHostManifest({
      name: 'n',
      description: 'd',
      hostBinaryPath: '/p',
      allowedExtensionIds: ['bbb', 'aaa', 'bbb'],
    });
    expect(m.allowed_origins).toEqual([
      'chrome-extension://aaa/',
      'chrome-extension://bbb/',
    ]);
  });

  it('throws on empty allowedExtensionIds', () => {
    expect(() =>
      buildHostManifest({
        name: 'n',
        description: 'd',
        hostBinaryPath: '/p',
        allowedExtensionIds: [],
      }),
    ).toThrow(/empty/);
  });
});

describe('writeHostManifestForBrowsers', () => {
  it('writes <name>.json to each browser dir, creating dirs as needed', async () => {
    const manifest = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'd',
      hostBinaryPath: '/abs',
      allowedExtensionIds: ['x'],
    });
    const browsers = fakeBrowsers(dir);
    const written = await writeHostManifestForBrowsers(manifest, browsers);
    expect(written).toHaveLength(2);
    for (const p of written) {
      expect(p.endsWith('com.pwa_debug.host.json')).toBe(true);
      const body = await readFile(p, 'utf-8');
      expect(JSON.parse(body)).toEqual(manifest);
    }
  });

  it('returns empty when no browsers given', async () => {
    const manifest = buildHostManifest({
      name: 'n',
      description: 'd',
      hostBinaryPath: '/p',
      allowedExtensionIds: ['x'],
    });
    const written = await writeHostManifestForBrowsers(manifest, []);
    expect(written).toEqual([]);
  });
});

describe('removeHostManifestForBrowsers', () => {
  it('returns only paths actually removed; missing files are skipped', async () => {
    const manifest = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'd',
      hostBinaryPath: '/abs',
      allowedExtensionIds: ['x'],
    });
    const browsers = fakeBrowsers(dir);
    await writeHostManifestForBrowsers(manifest, [browsers[0]!]);

    const removed = await removeHostManifestForBrowsers('com.pwa_debug.host', browsers);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain('google-chrome');

    await expect(stat(removed[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is idempotent: second call returns empty', async () => {
    const browsers = fakeBrowsers(dir);
    expect(await removeHostManifestForBrowsers('nope', browsers)).toEqual([]);
    expect(await removeHostManifestForBrowsers('nope', browsers)).toEqual([]);
  });
});
