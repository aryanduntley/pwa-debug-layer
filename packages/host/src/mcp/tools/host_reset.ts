import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  EMPTY_STATE,
  defaultStatePath,
  loadHostState,
  saveHostState,
} from '../../state/host_state.js';
import { detectBrowserInstalls } from '../../native-messaging/browser_paths.js';
import {
  uninstallManifestForBrowsers,
  type ManifestInstallOptions,
} from '../../native-messaging/manifest_writer.js';
import {
  defaultRegistryGateway,
  defaultRegistryJsonPath,
} from '../../native-messaging/registry_writer.js';

const HOST_NAME = 'com.pwa_debug.host';

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];

const inputSchema = { confirm: z.literal('reset') };

export const hostResetHandler = async (
  _args: z.infer<z.ZodObject<typeof inputSchema>>,
): Promise<ToolResponse> => {
  try {
    const statePath = defaultStatePath();
    const before = await loadHostState(statePath);

    const installs = await detectBrowserInstalls(
      process.env,
      process.platform,
      fileExists,
    );
    const hasRegistry = installs.some((i) => i.kind === 'registry');
    const registryOptions: ManifestInstallOptions = hasRegistry
      ? {
          registryJsonPath: defaultRegistryJsonPath(process.env, HOST_NAME),
          registry: defaultRegistryGateway(),
        }
      : {};

    const removedWrites = await uninstallManifestForBrowsers(
      HOST_NAME,
      installs,
      registryOptions,
    );
    await saveHostState(statePath, {
      ...EMPTY_STATE,
      lastUpdated: new Date().toISOString(),
    });

    return okResponse(
      {
        idsRemoved: [...before.extensionIds],
        pathsDeleted: dedupe(removedWrites.map((w) => w.manifestPath)),
        installs: removedWrites.map((w) => ({
          browser: w.browser,
          kind: w.kind,
          manifestPath: w.manifestPath,
          registrySubkey: w.registrySubkey,
        })),
      },
      [
        'All registrations cleared and host manifests deleted (Windows HKCU keys cleared too). Inform the user that any previously connected extensions will lose connectivity.',
        'To re-bootstrap, call host_register_extension with the desired extension ID.',
      ],
    );
  } catch (err) {
    return errorResponse(`host_reset failed: ${(err as Error).message}`, [
      'Filesystem or registry error during reset. Check write permissions on ~/.config/pwa-debug/, the per-browser NativeMessagingHosts dirs, %APPDATA%\\pwa-debug, and HKCU registry access.',
    ]);
  }
};

export const hostResetTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'host_reset',
  description:
    'DESTRUCTIVE: removes ALL registered extension IDs and deletes every per-browser host manifest (POSIX files + Windows HKCU keys + the shared %APPDATA% manifest JSON). Requires confirm:"reset" to invoke (a typed safety guard). Inform the user before calling. Use only when starting setup from scratch.',
  inputSchema,
  handler: hostResetHandler,
});
