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
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import type {
  IpcRequestEnvelope,
  IpcResponseEnvelope,
} from '../../../src/mcp/ipc/envelope.js';

let xdgDir: string;

const fakeChromeRoot = () => join(xdgDir, 'google-chrome');
const fakeChromeManifestPath = () =>
  join(fakeChromeRoot(), 'NativeMessagingHosts', 'com.pwa_debug.host.json');

type FakeIpcServerOpts = {
  readonly connections?: readonly IpcConnectionInfo[];
  readonly request?: (
    extensionId: string,
    env: IpcRequestEnvelope,
  ) => Promise<IpcResponseEnvelope>;
};

const buildFakeCtx = (opts: FakeIpcServerOpts = {}): {
  ctx: ToolContext;
  requests: Array<{ extensionId: string; env: IpcRequestEnvelope }>;
} => {
  const requests: Array<{ extensionId: string; env: IpcRequestEnvelope }> = [];
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (extensionId: string, env: IpcRequestEnvelope) => {
      requests.push({ extensionId, env });
      if (opts.request) return opts.request(extensionId, env);
      return Object.freeze({
        type: 'response' as const,
        requestId: env.requestId,
        payload: {},
      });
    },
    listConnections: () => opts.connections ?? [],
  });
  const ctx: ToolContext = Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
  });
  return { ctx, requests };
};

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
    const { ctx } = buildFakeCtx({ connections: [] });
    const r = await hostStatusHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      registeredExtensionIds: string[];
      activeConnections: unknown[];
    };
    expect(d.registeredExtensionIds).toEqual([]);
    expect(d.activeConnections).toEqual([]);
    expect(r.next_steps.join(' ')).toMatch(/host_register_extension/);
    expect(r.data).not.toHaveProperty('m3Note');
  });

  it('reports live activeConnections from ctx.ipcServer.listConnections()', async () => {
    await hostRegisterExtensionHandler({ extension_id: 'aaa' });
    const conn: IpcConnectionInfo = {
      extensionId: 'aaa',
      connectedAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_005_000,
    };
    const { ctx } = buildFakeCtx({ connections: [conn] });
    const r = await hostStatusHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { activeConnections: readonly IpcConnectionInfo[] };
    expect(d.activeConnections).toEqual([conn]);
    expect(r.next_steps.join(' ')).toMatch(/session_ping/);
    expect(r.next_steps.join(' ')).toMatch(/1 NMH connection/);
  });

  it('hints to reload the extension when registered but no NMH connected', async () => {
    await hostRegisterExtensionHandler({ extension_id: 'aaa' });
    const { ctx } = buildFakeCtx({ connections: [] });
    const r = await hostStatusHandler({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.next_steps.join(' ')).toMatch(/reload the extension/);
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

describe('session_ping', () => {
  it('errors when no NMH is connected', async () => {
    const { ctx } = buildFakeCtx({ connections: [] });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no NMH connected/);
    expect(r.next_steps.join(' ')).toMatch(/host_status/);
  });

  it('errors when multiple NMH are connected and no extension_id is given', async () => {
    const { ctx } = buildFakeCtx({
      connections: [
        { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
        { extensionId: 'bbb', connectedAt: 1, lastSeenAt: 1 },
      ],
    });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/multiple NMH connections/);
  });

  it('errors when extension_id is given but not connected', async () => {
    const { ctx } = buildFakeCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
    });
    const r = await sessionPingHandler({ extension_id: 'bbb' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no connected NMH for extension_id=bbb/);
  });

  it('returns round-trip data when the single connection responds', async () => {
    const { ctx, requests } = buildFakeCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      request: async (_extId, env) =>
        Object.freeze({
          type: 'response' as const,
          requestId: env.requestId,
          payload: { extensionVersion: '1.2.3', attachedTabId: 42 },
        }),
    });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      hostVersion: string;
      extensionVersion: string | null;
      attachedTabId: number | null;
      extensionId: string;
      latencyMs: number;
    };
    expect(d.hostVersion).toBe('0.0.0-test');
    expect(d.extensionVersion).toBe('1.2.3');
    expect(d.attachedTabId).toBe(42);
    expect(d.extensionId).toBe('aaa');
    expect(d.latencyMs).toBeGreaterThanOrEqual(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.env.tool).toBe('session_ping');
    expect(typeof requests[0]!.env.requestId).toBe('string');
    expect(requests[0]!.env.requestId.length).toBeGreaterThan(0);
  });

  it('returns null fields when SW response payload is incomplete', async () => {
    const { ctx } = buildFakeCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      request: async (_extId, env) =>
        Object.freeze({
          type: 'response' as const,
          requestId: env.requestId,
          payload: {},
        }),
    });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      extensionVersion: string | null;
      attachedTabId: number | null;
    };
    expect(d.extensionVersion).toBeNull();
    expect(d.attachedTabId).toBeNull();
  });

  it('surfaces IPC errors as ToolResponse errors', async () => {
    const { ctx } = buildFakeCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      request: async () => {
        throw new Error('boom: timeout');
      },
    });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom: timeout/);
  });

  it('surfaces NMH error envelopes as ToolResponse errors', async () => {
    const { ctx } = buildFakeCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      request: async (_extId, env) =>
        Object.freeze({
          type: 'response' as const,
          requestId: env.requestId,
          error: { message: 'sw responder unavailable' },
        }),
    });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sw responder unavailable/);
  });
});
