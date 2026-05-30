import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { stderr, stdin } from 'node:process';
import type { SettingChange } from '@pwa-debug/shared';
import { registerTools } from '../mcp/tool_registry.js';
import { TOOLS } from '../mcp/tools/index.js';
import { createIpcServer, type IpcServer } from '../mcp/ipc/ipc_server.js';
import type { IpcEventEnvelope } from '../mcp/ipc/envelope.js';
import { defaultSocketPath, socketParentDir } from '../mcp/ipc/socket_path.js';
import { installedSnapSocketTargets } from '../native-messaging/snap_host.js';
import {
  createCapturesRegistry,
  dispatchCapturesEvent,
} from '../captures_in/captures_in.js';
import {
  bridgeWriterToOnEvict,
  createArchiveWriter,
  pruneArchives,
} from '../host_archive/host_archive.js';
import {
  createSettingsStore,
  type SettingsStore,
} from '../host_settings/host_settings.js';
import { findLingeringTempProfiles } from '../browser_launch/node_deps.js';
import { tmpdir } from 'node:os';

const snapshotEvent = (store: SettingsStore): IpcEventEnvelope => ({
  type: 'event',
  tool: 'settings_snapshot',
  payload: { values: store.getAll() },
});

const changedEvent = (change: SettingChange): IpcEventEnvelope => ({
  type: 'event',
  tool: 'settings_changed',
  payload: change,
});

const broadcastChange = (
  ipcServer: IpcServer,
  store: SettingsStore,
  change: SettingChange,
): void => {
  const env = changedEvent(change);
  for (const conn of ipcServer.listConnections()) {
    ipcServer.sendTo(conn.extensionId, env);
  }
  void store; // store kept in scope; receivers re-read by id, not by closure
};

const FALLBACK_VERSION = '0.0.0';

const readHostVersion = async (): Promise<string> => {
  const mainJsPath = process.argv[1];
  if (typeof mainJsPath !== 'string' || mainJsPath === '') {
    return FALLBACK_VERSION;
  }
  try {
    const pkgPath = join(dirname(mainJsPath), '..', 'package.json');
    const parsed = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
};

const waitForShutdown = (): Promise<string> =>
  new Promise<string>((resolve) => {
    const onceOnly = (reason: string): void => resolve(reason);
    stdin.once('end', () => onceOnly('stdin EOF'));
    process.once('SIGINT', () => onceOnly('SIGINT'));
    process.once('SIGTERM', () => onceOnly('SIGTERM'));
  });

export const runMcpMode = async (): Promise<void> => {
  const socketPath = defaultSocketPath();
  const parentDir = socketParentDir(socketPath);
  if (parentDir !== null) {
    await mkdir(parentDir, { recursive: true });
  }

  // Snap confinement: a snap-spawned relay can only connect() to a socket under
  // ~/snap/<pkg>/common/, so bind one extra socket per installed snap browser
  // (in addition to the canonical socket above). Their parent dirs must exist
  // before listen(). No-op when no snap browser is installed.
  const pathExists = async (p: string): Promise<boolean> => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };
  const snapTargets = await installedSnapSocketTargets(process.env, pathExists);
  const extraSocketPaths = snapTargets.map((t) => t.socketPath);
  for (const p of extraSocketPaths) {
    await mkdir(dirname(p), { recursive: true });
  }

  const hostVersion = await readHostVersion();
  const settingsStore = createSettingsStore();
  await settingsStore.init();

  // Warn about sandbox-temp profile dirs left by a previous crashed run.
  // Graceful shutdown cleans its own, so survivors mean a SIGKILL/crash.
  // Warn-only — mkdtemp names don't identify the owner, so we can't safely
  // auto-remove (a concurrent host may still be using one).
  const lingering = findLingeringTempProfiles();
  if (lingering.length > 0) {
    stderr.write(
      `[pwa-debug-host mcp] note: ${lingering.length} lingering sandbox-temp profile dir(s) under ${tmpdir()} (e.g. ${lingering[0]}) from a previous run. Cleaned automatically on graceful shutdown; if no other pwa-debug host is running, remove ${join(tmpdir(), 'pwa-debug-*')} to reclaim space.\n`,
    );
  }

  // M8: one host-process session id scopes all archive output for this run.
  // Boot-time prune reaps anything from prior sessions before the writer
  // opens fresh files; the rotation hook fires a fire-and-forget prune so
  // both age + size caps are enforced as new files appear.
  const hostSessionId = randomUUID();
  await pruneArchives({ getSetting: settingsStore.getSetting }).catch((err) => {
    stderr.write(`[pwa-debug-host mcp] boot prune failed: ${String(err)}\n`);
  });
  const archiveWriter = createArchiveWriter({
    sessionId: hostSessionId,
    getSetting: settingsStore.getSetting,
    onRotate: () => {
      void pruneArchives({ getSetting: settingsStore.getSetting }).catch(
        () => undefined,
      );
    },
  });
  // Share hostSessionId across the registry so cursors the tail tools
  // encode (via the CapturesIn-attached sessionId metadata) match the
  // archive subtree the writer spills into. Without this, console.tail /
  // network.tail cursors would point at a different sessionId than
  // host_archive uses on disk.
  const capturesRegistry = createCapturesRegistry({
    sessionId: hostSessionId,
    onEvict: bridgeWriterToOnEvict(archiveWriter),
  });

  // The ipcServer reference is needed inside its own onRegister callback for
  // the initial snapshot push; bind via a late-initialized holder.
  let ipcServerRef: IpcServer | null = null;
  const ipcServer = await createIpcServer({
    socketPath,
    extraSocketPaths,
    onRegister: (info) => {
      ipcServerRef?.sendTo(info.extensionId, snapshotEvent(settingsStore));
    },
    onEvent: (extensionId, env) =>
      dispatchCapturesEvent(capturesRegistry, extensionId, env, {
        onMismatch: (msg) => stderr.write(`[pwa-debug-host mcp] ${msg}\n`),
        onInvalid: (msg) => stderr.write(`[pwa-debug-host mcp] ${msg}\n`),
      }),
  });
  ipcServerRef = ipcServer;

  const unsubscribeSettings = settingsStore.subscribe((change) => {
    broadcastChange(ipcServer, settingsStore, change);
  });

  try {
    const server = new McpServer({
      name: 'pwa-debug',
      version: '0.0.0-m4',
    });

    registerTools(server, TOOLS, {
      ipcServer,
      hostVersion,
      capturesRegistry,
      settingsStore,
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    stderr.write(
      `[pwa-debug-host mcp] server up on stdio; ${TOOLS.length} tools registered; ipc socket=${socketPath}${extraSocketPaths.length > 0 ? ` (+${extraSocketPaths.length} snap socket(s): ${extraSocketPaths.join(', ')})` : ''}\n`,
    );

    const reason = await waitForShutdown();
    stderr.write(`[pwa-debug-host mcp] ${reason}; shutting down\n`);
  } finally {
    unsubscribeSettings();
    await ipcServer.close();
    settingsStore.dispose();
    stderr.write('[pwa-debug-host mcp] ipc server closed\n');
  }
};
