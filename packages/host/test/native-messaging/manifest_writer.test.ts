import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHostManifest,
  installManifestForBrowsers,
  uninstallManifestForBrowsers,
} from '../../src/native-messaging/manifest_writer.js';
import type { BrowserInstall } from '../../src/native-messaging/browser_paths.js';
import type { RegistryGateway } from '../../src/native-messaging/registry_writer.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-mw-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const posixInstalls = (root: string): readonly BrowserInstall[] =>
  Object.freeze([
    Object.freeze({
      browser: 'chrome' as const,
      kind: 'native' as const,
      manifestDir: join(root, 'google-chrome', 'NativeMessagingHosts'),
    }),
    Object.freeze({
      browser: 'chromium' as const,
      kind: 'snap' as const,
      manifestDir: join(root, 'snap', 'chromium', 'NativeMessagingHosts'),
      caveat: 'snap caveat',
    }),
    Object.freeze({
      browser: 'brave' as const,
      kind: 'flatpak' as const,
      manifestDir: join(root, 'flatpak', 'brave', 'NativeMessagingHosts'),
      caveat: 'flatpak caveat',
    }),
  ]);

const fakeRegistry = (): {
  gateway: RegistryGateway;
  setCalls: { hive: string; subkey: string; valueData: string }[];
  removeCalls: { hive: string; subkey: string }[];
} => {
  const setCalls: { hive: string; subkey: string; valueData: string }[] = [];
  const removeCalls: { hive: string; subkey: string }[] = [];
  return {
    setCalls,
    removeCalls,
    gateway: {
      setDefault: async (hive, subkey, valueData) => {
        setCalls.push({ hive, subkey, valueData });
      },
      removeKey: async (hive, subkey) => {
        removeCalls.push({ hive, subkey });
      },
    },
  };
};

describe('buildHostManifest', () => {
  it('produces the expected shape with launcher path in path field', () => {
    const m = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'desc',
      hostBinaryPath: '/abs/launcher',
      allowedExtensionIds: ['abcdef'],
    });
    expect(m).toEqual({
      name: 'com.pwa_debug.host',
      description: 'desc',
      path: '/abs/launcher',
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

describe('installManifestForBrowsers — POSIX kinds', () => {
  it('writes <name>.json into native, snap, and flatpak dirs', async () => {
    const manifest = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'd',
      hostBinaryPath: '/abs/launcher',
      allowedExtensionIds: ['x'],
    });
    const installs = posixInstalls(dir);
    const writes = await installManifestForBrowsers(manifest, installs);
    expect(writes).toHaveLength(3);
    expect(writes.map((w) => w.kind).sort()).toEqual(['flatpak', 'native', 'snap']);
    for (const w of writes) {
      expect(w.manifestPath.endsWith('com.pwa_debug.host.json')).toBe(true);
      const body = await readFile(w.manifestPath, 'utf-8');
      expect(JSON.parse(body)).toEqual(manifest);
      expect(w.registrySubkey).toBeUndefined();
    }
  });

  it('returns empty when no installs given', async () => {
    const manifest = buildHostManifest({
      name: 'n',
      description: 'd',
      hostBinaryPath: '/p',
      allowedExtensionIds: ['x'],
    });
    const writes = await installManifestForBrowsers(manifest, []);
    expect(writes).toEqual([]);
  });
});

describe('installManifestForBrowsers — registry kind', () => {
  it('writes JSON once and sets HKCU default for each registry install', async () => {
    const manifest = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'd',
      hostBinaryPath: 'C:\\app\\launcher.bat',
      allowedExtensionIds: ['x'],
    });
    const installs: readonly BrowserInstall[] = Object.freeze([
      Object.freeze({
        browser: 'chrome' as const,
        kind: 'registry' as const,
        registryHive: 'HKCU' as const,
        registrySubkey: 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.pwa_debug.host',
      }),
      Object.freeze({
        browser: 'edge' as const,
        kind: 'registry' as const,
        registryHive: 'HKCU' as const,
        registrySubkey: 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.pwa_debug.host',
      }),
    ]);
    const jsonPath = join(dir, 'pwa-debug', 'com.pwa_debug.host.json');
    const reg = fakeRegistry();
    const writes = await installManifestForBrowsers(manifest, installs, {
      registryJsonPath: jsonPath,
      registry: reg.gateway,
    });
    expect(writes).toHaveLength(2);
    expect(writes.every((w) => w.manifestPath === jsonPath)).toBe(true);
    expect(writes.map((w) => w.registrySubkey).sort()).toEqual([
      'Software\\Google\\Chrome\\NativeMessagingHosts\\com.pwa_debug.host',
      'Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.pwa_debug.host',
    ]);
    expect(reg.setCalls).toHaveLength(2);
    expect(reg.setCalls.every((c) => c.valueData === jsonPath && c.hive === 'HKCU')).toBe(true);
    const body = await readFile(jsonPath, 'utf-8');
    expect(JSON.parse(body)).toEqual(manifest);
  });

  it('throws when registry installs are present but options are missing', async () => {
    const manifest = buildHostManifest({
      name: 'n',
      description: 'd',
      hostBinaryPath: '/p',
      allowedExtensionIds: ['x'],
    });
    const installs: readonly BrowserInstall[] = Object.freeze([
      Object.freeze({
        browser: 'chrome' as const,
        kind: 'registry' as const,
        registryHive: 'HKCU' as const,
        registrySubkey: 'Software\\X',
      }),
    ]);
    await expect(installManifestForBrowsers(manifest, installs, {})).rejects.toThrow(
      /registryJsonPath/,
    );
  });
});

describe('installManifestForBrowsers — mixed POSIX + registry', () => {
  it('dispatches each install to its kind', async () => {
    const manifest = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'd',
      hostBinaryPath: '/abs/launcher',
      allowedExtensionIds: ['x'],
    });
    const installs: readonly BrowserInstall[] = Object.freeze([
      Object.freeze({
        browser: 'chrome' as const,
        kind: 'native' as const,
        manifestDir: join(dir, 'native', 'NativeMessagingHosts'),
      }),
      Object.freeze({
        browser: 'edge' as const,
        kind: 'registry' as const,
        registryHive: 'HKCU' as const,
        registrySubkey: 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.pwa_debug.host',
      }),
    ]);
    const jsonPath = join(dir, 'pwa-debug', 'com.pwa_debug.host.json');
    const reg = fakeRegistry();
    const writes = await installManifestForBrowsers(manifest, installs, {
      registryJsonPath: jsonPath,
      registry: reg.gateway,
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]?.kind).toBe('native');
    expect(writes[1]?.kind).toBe('registry');
    expect(reg.setCalls).toHaveLength(1);
    await expect(stat(writes[0]!.manifestPath)).resolves.toBeTruthy();
    await expect(stat(jsonPath)).resolves.toBeTruthy();
  });
});

describe('uninstallManifestForBrowsers', () => {
  it('removes POSIX files that exist; idempotent on missing files', async () => {
    const manifest = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'd',
      hostBinaryPath: '/abs',
      allowedExtensionIds: ['x'],
    });
    const installs = posixInstalls(dir);
    await installManifestForBrowsers(manifest, [installs[0]!]);
    const removed = await uninstallManifestForBrowsers('com.pwa_debug.host', installs);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.manifestPath).toContain('google-chrome');
    await expect(stat(removed[0]!.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const removedAgain = await uninstallManifestForBrowsers('com.pwa_debug.host', installs);
    expect(removedAgain).toEqual([]);
  });

  it('removes registry keys via the gateway and unlinks the shared JSON', async () => {
    const manifest = buildHostManifest({
      name: 'com.pwa_debug.host',
      description: 'd',
      hostBinaryPath: 'C:\\app\\launcher.bat',
      allowedExtensionIds: ['x'],
    });
    const installs: readonly BrowserInstall[] = Object.freeze([
      Object.freeze({
        browser: 'chrome' as const,
        kind: 'registry' as const,
        registryHive: 'HKCU' as const,
        registrySubkey: 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.pwa_debug.host',
      }),
    ]);
    const jsonPath = join(dir, 'pwa-debug', 'com.pwa_debug.host.json');
    const reg = fakeRegistry();
    await installManifestForBrowsers(manifest, installs, {
      registryJsonPath: jsonPath,
      registry: reg.gateway,
    });
    await expect(stat(jsonPath)).resolves.toBeTruthy();

    const removed = await uninstallManifestForBrowsers('com.pwa_debug.host', installs, {
      registryJsonPath: jsonPath,
      registry: reg.gateway,
    });
    expect(removed).toHaveLength(1);
    expect(reg.removeCalls).toHaveLength(1);
    expect(reg.removeCalls[0]?.subkey).toBe(
      'Software\\Google\\Chrome\\NativeMessagingHosts\\com.pwa_debug.host',
    );
    await expect(stat(jsonPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
