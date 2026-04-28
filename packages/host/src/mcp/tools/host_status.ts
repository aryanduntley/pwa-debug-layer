import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { defaultStatePath, loadHostState } from '../../state/host_state.js';
import {
  detectBrowserInstalls,
  type BrowserInstall,
} from '../../native-messaging/browser_paths.js';
import { defaultLauncherPath } from '../../native-messaging/launcher.js';

const HOST_NAME = 'com.pwa_debug.host';

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const expectedManifestPath = (install: BrowserInstall): string | null => {
  if (install.kind === 'registry') return null;
  const segments = install.manifestDir.endsWith('/')
    ? `${install.manifestDir}${HOST_NAME}.json`
    : `${install.manifestDir}/${HOST_NAME}.json`;
  return segments;
};

const safeLauncherPath = (): string | null => {
  try {
    return defaultLauncherPath(process.platform, process.env);
  } catch {
    return null;
  }
};

export const hostStatusHandler = async (
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  try {
    const statePath = defaultStatePath();
    const state = await loadHostState(statePath);
    const installs = await detectBrowserInstalls(
      process.env,
      process.platform,
      fileExists,
    );

    const installReports = await Promise.all(
      installs.map(async (install) => {
        if (install.kind === 'registry') {
          return {
            browser: install.browser,
            kind: install.kind,
            registrySubkey: install.registrySubkey,
            manifestOnDisk: false as const,
            verifiable: false as const,
          };
        }
        const path = expectedManifestPath(install) ?? '';
        const exists = path !== '' && (await fileExists(path));
        return {
          browser: install.browser,
          kind: install.kind,
          manifestPath: path,
          manifestOnDisk: exists,
          verifiable: true as const,
          ...(install.caveat ? { caveat: install.caveat } : {}),
        };
      }),
    );

    const manifestPathsOnDisk: string[] = [];
    for (const p of state.lastInstalledManifestPaths) {
      if (await fileExists(p)) manifestPathsOnDisk.push(p);
    }

    const launcherPath = safeLauncherPath();
    const launcherOnDisk = launcherPath !== null && (await fileExists(launcherPath));

    const activeConnections = ctx.ipcServer.listConnections();

    const data = {
      hostBinaryPath: process.argv[1] ?? '',
      stateFilePath: statePath,
      registeredExtensionIds: [...state.extensionIds],
      manifestPathsOnDisk,
      launcherPath,
      launcherOnDisk,
      installs: installReports,
      detectedBrowsers: installs.map((i) => i.browser),
      activeConnections,
    };

    const next_steps: string[] = [];
    if (state.extensionIds.length === 0) {
      next_steps.push(
        'No extensions registered. Use chrome-devtools-mcp to read the pwa-debug service-worker console for a line like `[pwa-debug/sw] id=<id>`, then call host_register_extension with that ID.',
      );
    } else if (manifestPathsOnDisk.length === 0) {
      next_steps.push(
        'State records registered IDs but no manifest is present on disk. Call host_register_extension with the same ID to recreate per-browser manifests.',
      );
    } else if (!launcherOnDisk) {
      next_steps.push(
        'Manifest exists on disk but the launcher script is missing. Re-run host_register_extension with an existing ID to refresh the launcher.',
      );
    } else if (activeConnections.length === 0) {
      next_steps.push(
        'Manifest is installed and at least one extension ID is registered, but no NMH instance is currently connected. Ask the user to reload the extension at chrome://extensions so Chrome respawns the NMH; activeConnections will populate once the SW reconnects.',
      );
    } else {
      next_steps.push(
        `Manifest is installed, launcher is present, and ${activeConnections.length} NMH connection(s) are live. Call session_ping (optionally with extension_id) for a full round-trip via the IPC bridge.`,
      );
    }
    for (const r of installReports) {
      if (r.verifiable && !r.manifestOnDisk) {
        next_steps.push(
          `${r.browser} (${r.kind}): expected manifest at ${r.manifestPath} but file is missing. Re-run host_register_extension to recreate.`,
        );
      }
      if (r.verifiable && 'caveat' in r && r.caveat) {
        next_steps.push(`${r.browser} (${r.kind}): ${r.caveat}`);
      }
    }
    if (state.extensionIds.length > 0 && manifestPathsOnDisk.length === 0) {
      next_steps.push('To uninstall cleanly, call host_reset.');
    }

    return okResponse(data, next_steps);
  } catch (err) {
    return errorResponse(`host_status failed: ${(err as Error).message}`, [
      'Filesystem error reading state. Check ~/.config/pwa-debug/state.json permissions and disk space.',
    ]);
  }
};

export const hostStatusTool: ToolDef<Record<string, never>> = Object.freeze({
  name: 'host_status',
  description:
    'Reports the install/liveness state of the pwa-debug native messaging host: registered extension IDs, expected manifest paths per detected browser install (with on-disk verification for POSIX kinds), launcher script path + presence, and the host binary path. Cheap, idempotent, no side effects. CALL THIS BEFORE ANY OTHER pwa-debug TOOL to confirm setup. The structured response includes a next_steps[] array tailored to the actual state — follow it.',
  inputSchema: {} as Record<string, never>,
  handler: hostStatusHandler,
});

void z;
