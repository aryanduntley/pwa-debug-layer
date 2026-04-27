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
import {
  detectBrowserInstalls,
  type BrowserInstall,
} from '../../native-messaging/browser_paths.js';
import {
  buildHostManifest,
  installManifestForBrowsers,
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

const installCaveatLines = (installs: readonly BrowserInstall[]): string[] =>
  installs
    .filter((i) => i.kind !== 'registry' && i.caveat)
    .map((i) => `${i.browser} (${i.kind}): ${i.caveat}`);

const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];

const inputSchema = { extension_id: z.string().min(1) };

export const hostRegisterExtensionHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
): Promise<ToolResponse> => {
  try {
    const statePath = defaultStatePath();
    const before = await loadHostState(statePath);
    const after = addExtensionId(before, args.extension_id);
    const added = after !== before;

    const installs = await detectBrowserInstalls(
      process.env,
      process.platform,
      fileExists,
    );
    if (installs.length === 0) {
      return errorResponse(
        'No Chromium-family browser detected on this machine.',
        [
          'Verify a Chromium-family browser (Chrome, Chromium, Edge, Brave, Vivaldi, Opera) is installed and has been launched at least once. Detection covers Linux native packages, Linux snap, Linux flatpak, macOS Application Support, and Windows HKCU registry vendors.',
        ],
      );
    }

    const mainJsPath = process.argv[1] ?? '';
    if (mainJsPath === '') {
      return errorResponse(
        'host_register_extension: cannot determine bundled main.js path (process.argv[1] is empty).',
        [
          'This usually means the host was not started as `node /path/to/dist/main.js`. Verify your Claude Code MCP config points at the host binary directly.',
        ],
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

    const hasRegistry = installs.some((i) => i.kind === 'registry');
    const options: ManifestInstallOptions = hasRegistry
      ? {
          registryJsonPath: defaultRegistryJsonPath(process.env, HOST_NAME),
          registry: defaultRegistryGateway(),
        }
      : {};

    const writes = await installManifestForBrowsers(manifest, installs, options);
    const written = dedupe(writes.map((w) => w.manifestPath));

    const final = setManifestPaths(
      { ...after, lastUpdated: new Date().toISOString() },
      written,
    );
    await saveHostState(statePath, final);

    const data = {
      added,
      allRegisteredIds: [...final.extensionIds],
      manifestPathsWritten: written,
      installs: writes.map((w) => ({
        browser: w.browser,
        kind: w.kind,
        manifestPath: w.manifestPath,
        registrySubkey: w.registrySubkey,
      })),
      launcherPath,
      requiresReload: added,
      detectedBrowsers: installs.map((i) => i.browser),
    };

    const next_steps: string[] = [];
    if (added) {
      next_steps.push(
        'New extension ID registered. Tell the user: "Reload the PWA Debug Layer extension at chrome://extensions (click the circular reload icon on its card)" so Chrome re-reads allowed_origins.',
      );
      next_steps.push(
        'After ~3s, call host_status to confirm the manifestPathsOnDisk list includes the written path. (activeConnections still always [] in M3-skeleton; full round-trip lands when IPC ships in M4.)',
      );
    } else {
      next_steps.push(
        'Extension ID was already registered; manifest rewritten with the same allowed_origins. No reload needed unless the extension is also showing as not-yet-connected.',
      );
    }
    for (const line of installCaveatLines(installs)) next_steps.push(line);
    return okResponse(data, next_steps);
  } catch (err) {
    return errorResponse(
      `host_register_extension failed: ${(err as Error).message}`,
      [
        'Filesystem or registry error during install. Check write permissions on the per-browser NativeMessagingHosts directories (POSIX), %APPDATA%\\pwa-debug (Windows), or HKCU registry access (Windows).',
      ],
    );
  }
};

export const hostRegisterExtensionTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'host_register_extension',
  description:
    "Registers an extension ID as an allowed origin for the pwa-debug native messaging host. Detects every Chromium-family install on this machine — Linux native packages, Linux snap (Chromium), Linux flatpak (any vendor), macOS Application Support, Windows HKCU registry — and writes the host manifest into each one. Also drops an install-time launcher script (POSIX sh / Windows .bat) that embeds an absolute node path so the host spawns correctly under sandboxed/stripped PATH (snap, flatpak). Idempotent. ID DISCOVERY: read the pwa-debug service-worker console via chrome-devtools-mcp — the SW logs `[pwa-debug/sw] id=<id>` on every boot. NEVER invent an ID. After this returns requiresReload:true, the user must reload the extension at chrome://extensions for Chrome to re-validate allowed_origins. If next_steps mentions a flatpak caveat, surface it to the user verbatim.",
  inputSchema,
  handler: hostRegisterExtensionHandler,
});
