import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { defaultStatePath, loadHostState } from '../../state/host_state.js';
import { join } from 'node:path';

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

export const hostStatusHandler = async (): Promise<ToolResponse> => {
  try {
    const statePath = defaultStatePath();
    const state = await loadHostState(statePath);
    const manifestPathsOnDisk: string[] = [];
    for (const p of state.lastInstalledManifestPaths) {
      if (await fileExists(p)) manifestPathsOnDisk.push(p);
    }

    const data = {
      hostBinaryPath: process.argv[1] ?? '',
      stateFilePath: statePath,
      registeredExtensionIds: [...state.extensionIds],
      manifestPathsOnDisk,
      activeConnections: [] as readonly { extensionId: string; connectedAt: string }[],
      m3Note:
        'activeConnections is always [] until the IPC bridge between MCP-mode and NMH-mode ships (M3 task item 25).',
    };

    const next_steps: string[] = [];
    if (state.extensionIds.length === 0) {
      next_steps.push(
        'No extensions registered. Use chrome-devtools-mcp to read the pwa-debug service-worker console for a line like `[pwa-debug/sw] id=<id>`, then call host_register_extension with that ID.',
      );
    } else if (manifestPathsOnDisk.length === 0) {
      next_steps.push(
        'State records registered IDs but no manifest file is on disk. Call host_register_extension with the same ID to recreate the per-browser manifests.',
      );
    } else {
      next_steps.push(
        'Manifest is installed and at least one extension ID is registered. Once IPC is wired (M3 item 25), activeConnections will populate; until then, run session_ping to surface the M3-skeleton state.',
      );
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
    'Reports the install/liveness state of the pwa-debug native messaging host: which extension IDs are registered, which per-browser manifest paths exist on disk, the host binary path, and the state-file location. Cheap, idempotent, no side effects. CALL THIS BEFORE ANY OTHER pwa-debug TOOL to confirm setup. The structured response includes a next_steps[] array tailored to the actual state — follow it.',
  inputSchema: {} as Record<string, never>,
  handler: hostStatusHandler,
});

// satisfy unused import warning (z used in tools that take args)
void z;
