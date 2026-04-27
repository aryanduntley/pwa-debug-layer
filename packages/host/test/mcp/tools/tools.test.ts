import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostStatusHandler } from '../../../src/mcp/tools/host_status.js';
import { hostRegisterExtensionHandler } from '../../../src/mcp/tools/host_register_extension.js';
import { hostUnregisterExtensionHandler } from '../../../src/mcp/tools/host_unregister_extension.js';
import { hostListRegistrationsHandler } from '../../../src/mcp/tools/host_list_registrations.js';
import { hostResetHandler } from '../../../src/mcp/tools/host_reset.js';
import { sessionPingHandler } from '../../../src/mcp/tools/session_ping.js';

let xdgDir: string;

const fakeChromeRoot = () => join(xdgDir, 'google-chrome');
const fakeChromeManifestPath = () =>
  join(fakeChromeRoot(), 'NativeMessagingHosts', 'com.pwa_debug.host.json');

beforeEach(async () => {
  xdgDir = await mkdtemp(join(tmpdir(), 'pwa-debug-tools-'));
  await mkdir(fakeChromeRoot(), { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', xdgDir);
  // Pin HOME to the same isolated dir so snap (~/snap/...) and flatpak
  // (~/.var/app/...) detection cannot leak the user's real installs.
  vi.stubEnv('HOME', xdgDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(xdgDir, { recursive: true, force: true });
});

describe('host_status', () => {
  it('reports empty state with guidance to call host_register_extension', async () => {
    const r = await hostStatusHandler();
    expect(r.ok).toBe(true);
    const d = r.data as { registeredExtensionIds: string[]; activeConnections: unknown[] };
    expect(d.registeredExtensionIds).toEqual([]);
    expect(d.activeConnections).toEqual([]);
    expect(r.next_steps.join(' ')).toMatch(/host_register_extension/);
  });
});

describe('host_register_extension', () => {
  it('adds ID, writes manifest, requiresReload:true', async () => {
    const r = await hostRegisterExtensionHandler({ extension_id: 'abcdef' });
    expect(r.ok).toBe(true);
    const d = r.data as {
      added: boolean;
      allRegisteredIds: string[];
      manifestPathsWritten: string[];
      requiresReload: boolean;
    };
    expect(d.added).toBe(true);
    expect(d.requiresReload).toBe(true);
    expect(d.allRegisteredIds).toEqual(['abcdef']);
    expect(d.manifestPathsWritten[0]).toBe(fakeChromeManifestPath());
    const written = JSON.parse(await readFile(fakeChromeManifestPath(), 'utf-8'));
    expect(written.allowed_origins).toEqual(['chrome-extension://abcdef/']);
  });

  it('is idempotent: second call returns added:false', async () => {
    await hostRegisterExtensionHandler({ extension_id: 'abcdef' });
    const r2 = await hostRegisterExtensionHandler({ extension_id: 'abcdef' });
    const d = r2.data as { added: boolean; requiresReload: boolean };
    expect(d.added).toBe(false);
    expect(d.requiresReload).toBe(false);
  });

  it('errors with helpful guidance when no browser is installed', async () => {
    await rm(fakeChromeRoot(), { recursive: true });
    const r = await hostRegisterExtensionHandler({ extension_id: 'abcdef' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No Chromium-family browser/);
  });
});

describe('host_unregister_extension', () => {
  it('returns removed:false no-op when ID is absent', async () => {
    const r = await hostUnregisterExtensionHandler({ extension_id: 'never' });
    expect(r.ok).toBe(true);
    const d = r.data as { removed: boolean; remainingIds: string[] };
    expect(d.removed).toBe(false);
    expect(d.remainingIds).toEqual([]);
  });

  it('removes ID and rewrites manifest with the remaining union', async () => {
    await hostRegisterExtensionHandler({ extension_id: 'aaa' });
    await hostRegisterExtensionHandler({ extension_id: 'bbb' });
    const r = await hostUnregisterExtensionHandler({ extension_id: 'aaa' });
    const d = r.data as {
      removed: boolean;
      remainingIds: string[];
      manifestPathsRewritten: string[];
      manifestPathsDeleted: string[];
    };
    expect(d.removed).toBe(true);
    expect(d.remainingIds).toEqual(['bbb']);
    expect(d.manifestPathsRewritten).toHaveLength(1);
    expect(d.manifestPathsDeleted).toEqual([]);
    const m = JSON.parse(await readFile(fakeChromeManifestPath(), 'utf-8'));
    expect(m.allowed_origins).toEqual(['chrome-extension://bbb/']);
  });

  it('deletes manifest entirely when removing the last ID', async () => {
    await hostRegisterExtensionHandler({ extension_id: 'only' });
    const r = await hostUnregisterExtensionHandler({ extension_id: 'only' });
    const d = r.data as {
      removed: boolean;
      remainingIds: string[];
      manifestPathsDeleted: string[];
    };
    expect(d.removed).toBe(true);
    expect(d.remainingIds).toEqual([]);
    expect(d.manifestPathsDeleted).toContain(fakeChromeManifestPath());
    await expect(stat(fakeChromeManifestPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('host_list_registrations', () => {
  it('returns empty list with guidance', async () => {
    const r = await hostListRegistrationsHandler();
    expect(r.ok).toBe(true);
    expect((r.data as { extensionIds: string[] }).extensionIds).toEqual([]);
    expect(r.next_steps.join(' ')).toMatch(/host_register_extension/);
  });

  it('returns the registered IDs after registration', async () => {
    await hostRegisterExtensionHandler({ extension_id: 'aaa' });
    await hostRegisterExtensionHandler({ extension_id: 'bbb' });
    const r = await hostListRegistrationsHandler();
    expect((r.data as { extensionIds: string[] }).extensionIds).toEqual(['aaa', 'bbb']);
  });
});

describe('host_reset', () => {
  it('clears all registrations and deletes manifests', async () => {
    await hostRegisterExtensionHandler({ extension_id: 'aaa' });
    await hostRegisterExtensionHandler({ extension_id: 'bbb' });
    const r = await hostResetHandler({ confirm: 'reset' });
    const d = r.data as { idsRemoved: string[]; pathsDeleted: string[] };
    expect(d.idsRemoved).toEqual(['aaa', 'bbb']);
    expect(d.pathsDeleted).toContain(fakeChromeManifestPath());
    await expect(stat(fakeChromeManifestPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('session_ping (M3 skeleton)', () => {
  it('returns hostUnreachable:true with M3 hint', async () => {
    const r = await sessionPingHandler();
    expect(r.ok).toBe(true);
    const d = r.data as { hostUnreachable: boolean; reason: string };
    expect(d.hostUnreachable).toBe(true);
    expect(d.reason).toMatch(/IPC bridge/);
    expect(r.next_steps.join(' ')).toMatch(/IPC/);
  });
});
