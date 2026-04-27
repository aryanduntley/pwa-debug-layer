import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  defaultStatePath,
  loadHostState,
  saveHostState,
  removeExtensionId,
  setManifestPaths,
} from '../../state/host_state.js';
import { detectBrowserInstalls } from '../../native-messaging/browser_paths.js';
import {
  buildHostManifest,
  installManifestForBrowsers,
  uninstallManifestForBrowsers,
  type ManifestInstallOptions,
} from '../../native-messaging/manifest_writer.js';
import {
  defaultLauncherPath,
  writeLauncher,
} from '../../native-messaging/launcher.js';
import {
  defaultRegistryGateway,
  defaultRegistryJsonPath,
} from '../../native-messaging/registry_writer.js';

const HOST_NAME = 'com.pwa_debug.host';
const HOST_DESCRIPTION = 'PWA Debug Layer native messaging host';

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];

const inputSchema = { extension_id: z.string().min(1) };

export const hostUnregisterExtensionHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
): Promise<ToolResponse> => {
  try {
    const statePath = defaultStatePath();
    const before = await loadHostState(statePath);
    const after = removeExtensionId(before, args.extension_id);
    const removed = after !== before;

    if (!removed) {
      return okResponse(
        {
          removed: false,
          remainingIds: [...before.extensionIds],
          manifestPathsDeleted: [],
          manifestPathsRewritten: [],
        },
        [
          'Extension ID was not registered; no-op. Call host_list_registrations to see what is currently registered.',
        ],
      );
    }

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

    if (after.extensionIds.length === 0) {
      const removedWrites = await uninstallManifestForBrowsers(
        HOST_NAME,
        installs,
        registryOptions,
      );
      const final = setManifestPaths(
        { ...after, lastUpdated: new Date().toISOString() },
        [],
      );
      await saveHostState(statePath, final);
      return okResponse(
        {
          removed: true,
          remainingIds: [],
          manifestPathsDeleted: dedupe(removedWrites.map((w) => w.manifestPath)),
          manifestPathsRewritten: [],
          installs: removedWrites.map((w) => ({
            browser: w.browser,
            kind: w.kind,
            manifestPath: w.manifestPath,
            registrySubkey: w.registrySubkey,
          })),
        },
        [
          'Last registration removed; per-browser host manifests deleted (and Windows HKCU keys cleared). The host is fully uninstalled. Future pwa-debug tool calls will surface "no extensions registered" until host_register_extension is called again.',
        ],
      );
    }

    const mainJsPath = process.argv[1] ?? '';
    if (mainJsPath === '') {
      return errorResponse(
        'host_unregister_extension: cannot determine bundled main.js path (process.argv[1] is empty).',
        [],
      );
    }
    const launcherPath = defaultLauncherPath(process.platform, process.env);
    await writeLauncher(
      process.platform,
      { nodePath: process.execPath, mainJsPath },
      launcherPath,
    );

    const manifest = buildHostManifest({
      name: HOST_NAME,
      description: HOST_DESCRIPTION,
      hostBinaryPath: launcherPath,
      allowedExtensionIds: after.extensionIds,
    });
    const writes = await installManifestForBrowsers(manifest, installs, registryOptions);
    const written = dedupe(writes.map((w) => w.manifestPath));

    const final = setManifestPaths(
      { ...after, lastUpdated: new Date().toISOString() },
      written,
    );
    await saveHostState(statePath, final);

    return okResponse(
      {
        removed: true,
        remainingIds: [...after.extensionIds],
        manifestPathsDeleted: [],
        manifestPathsRewritten: written,
        installs: writes.map((w) => ({
          browser: w.browser,
          kind: w.kind,
          manifestPath: w.manifestPath,
          registrySubkey: w.registrySubkey,
        })),
      },
      [
        'Extension ID removed; manifest rewritten with the remaining IDs in allowed_origins. The other extensions remain functional.',
      ],
    );
  } catch (err) {
    return errorResponse(
      `host_unregister_extension failed: ${(err as Error).message}`,
      [
        'Filesystem or registry error during unregister. Check write permissions on per-browser NativeMessagingHosts dirs (POSIX), %APPDATA%\\pwa-debug (Windows), and HKCU registry access (Windows).',
      ],
    );
  }
};

export const hostUnregisterExtensionTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'host_unregister_extension',
  description:
    "Removes an extension ID from the pwa-debug host manifest allowed_origins. If at least one ID remains, manifests are rewritten with the new union; if the last ID is removed, manifests are deleted entirely (Windows HKCU keys cleared too). Use to recycle stale IDs after a manifest key change in dev. Idempotent: removing an already-absent ID returns removed:false with no side effects.",
  inputSchema,
  handler: hostUnregisterExtensionHandler,
});
