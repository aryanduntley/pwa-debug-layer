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
  addExtensionId,
  setManifestPaths,
} from '../../state/host_state.js';
import { findInstalledBrowsers } from '../../native-messaging/browser_paths.js';
import {
  buildHostManifest,
  writeHostManifestForBrowsers,
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

export const hostRegisterExtensionHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
): Promise<ToolResponse> => {
  try {
    const statePath = defaultStatePath();
    const before = await loadHostState(statePath);
    const after = addExtensionId(before, args.extension_id);
    const added = after !== before;

    const browsers = await findInstalledBrowsers(process.env, process.platform, fileExists);
    if (browsers.length === 0) {
      return errorResponse(
        'No Chromium-family browser detected at standard XDG paths.',
        [
          'Verify that Chrome / Chromium / Edge / Brave / Vivaldi / Opera is installed and has been launched at least once (so its config directory exists under XDG_CONFIG_HOME or ~/.config).',
          'M3 supports Linux only — macOS/Windows paths arrive in a later milestone.',
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

    const data = {
      added,
      allRegisteredIds: [...final.extensionIds],
      manifestPathsWritten: [...written],
      requiresReload: added,
      detectedBrowsers: browsers.map((b) => b.name),
    };

    const next_steps: string[] = [];
    if (added) {
      next_steps.push(
        'New extension ID registered. Tell the user: "Reload the PWA Debug Layer extension at chrome://extensions (click the circular reload icon on its card)" so Chrome re-reads allowed_origins.',
      );
      next_steps.push(
        'After ~3s, call host_status to confirm the manifestPathsOnDisk list includes the written path. (activeConnections still always [] in M3-skeleton; verify the round-trip with session_ping after item 25 lands.)',
      );
    } else {
      next_steps.push(
        'Extension ID was already registered; manifest rewritten with the same allowed_origins. No reload needed unless the extension is also showing as not-yet-connected.',
      );
    }
    return okResponse(data, next_steps);
  } catch (err) {
    return errorResponse(
      `host_register_extension failed: ${(err as Error).message}`,
      [
        'Filesystem error writing the host manifest. Check write permissions on the per-browser NativeMessagingHosts directories under ~/.config.',
      ],
    );
  }
};

export const hostRegisterExtensionTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'host_register_extension',
  description:
    'Registers an extension ID as an allowed origin for the pwa-debug native messaging host. Writes per-browser host manifests to ~/.config/{google-chrome,chromium,microsoft-edge,brave-browser,vivaldi,opera}/NativeMessagingHosts/com.pwa_debug.host.json (only for browsers that have a config directory). Idempotent. ID DISCOVERY: read the pwa-debug service-worker console via chrome-devtools-mcp — the SW logs `[pwa-debug/sw] id=<id>` on every boot. NEVER invent an ID. After this returns requiresReload:true, the user must reload the extension at chrome://extensions for Chrome to re-validate allowed_origins.',
  inputSchema,
  handler: hostRegisterExtensionHandler,
});
