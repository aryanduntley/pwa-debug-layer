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
import { findInstalledBrowsers } from '../../native-messaging/browser_paths.js';
import {
  buildHostManifest,
  writeHostManifestForBrowsers,
  removeHostManifestForBrowsers,
} from '../../native-messaging/manifest_writer.js';

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
          `Extension ID was not registered; no-op. Call host_list_registrations to see what is currently registered.`,
        ],
      );
    }

    const browsers = await findInstalledBrowsers(process.env, process.platform, fileExists);

    if (after.extensionIds.length === 0) {
      const deleted = await removeHostManifestForBrowsers(HOST_NAME, browsers);
      const final = setManifestPaths(
        { ...after, lastUpdated: new Date().toISOString() },
        [],
      );
      await saveHostState(statePath, final);
      return okResponse(
        {
          removed: true,
          remainingIds: [],
          manifestPathsDeleted: [...deleted],
          manifestPathsRewritten: [],
        },
        [
          'Last registration removed; per-browser host manifests deleted. The host is fully uninstalled. Future pwa-debug tool calls will surface "no extensions registered" until host_register_extension is called again.',
        ],
      );
    }

    const manifest = buildHostManifest({
      name: HOST_NAME,
      description: HOST_DESCRIPTION,
      hostBinaryPath: process.argv[1] ?? '',
      allowedExtensionIds: after.extensionIds,
    });
    const written = await writeHostManifestForBrowsers(manifest, browsers);
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
        manifestPathsRewritten: [...written],
      },
      [
        'Extension ID removed; manifest rewritten with the remaining IDs in allowed_origins. The other extensions remain functional.',
      ],
    );
  } catch (err) {
    return errorResponse(
      `host_unregister_extension failed: ${(err as Error).message}`,
      [
        'Filesystem error during unregister. Check write permissions on the per-browser NativeMessagingHosts directories.',
      ],
    );
  }
};

export const hostUnregisterExtensionTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'host_unregister_extension',
  description:
    'Removes an extension ID from the pwa-debug host manifest allowed_origins. If at least one ID remains, manifests are rewritten with the new union; if the last ID is removed, the manifests are deleted entirely. Use to recycle stale IDs after a manifest key change in dev. Idempotent: removing an already-absent ID returns removed:false with no side effects.',
  inputSchema,
  handler: hostUnregisterExtensionHandler,
});
