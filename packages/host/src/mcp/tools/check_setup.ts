import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  okResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  detectBrowserInstalls,
  type BrowserInstall,
} from '../../native-messaging/browser_paths.js';
import { defaultStatePath, loadHostState } from '../../state/host_state.js';
import {
  fetchLoadedExtensionIds,
  getLaunchRegistry,
  readChromeDevtoolsRegistration,
  resolveExtensionPath,
  type ChromeDevtoolsRegistration,
} from '../../browser_launch/node_deps.js';
import { browserUrlFor } from '../../browser_launch/spawn_args.js';
import { deriveBundledExtensionId } from '../../extension_identity/extension_id.js';
import { cdpAddSnippet, cdpPortOf, expectedCdpPort } from './_cdp_registration.js';

const inputSchema = {} as Record<string, never>;

const HOST_NAME = 'com.pwa_debug.host';

type StateView = { readonly extensionIds: readonly string[] };

/** A managed browser launch the live extension-id probe can reach. */
type ManagedPort = { readonly port: number; readonly sandbox: boolean };

/** Injected probes so the gap analysis is testable without the `claude` CLI / fs / state. */
export type CheckSetupDeps = {
  /** Real chrome-devtools-mcp registration read from the `claude` CLI. */
  readonly readCdpRegistration: () => Promise<ChromeDevtoolsRegistration>;
  /** Host launch.defaultPort — the fallback debug port when no managed browser is live. */
  readonly defaultPort: () => number;
  readonly detectInstalls: () => Promise<readonly BrowserInstall[]>;
  readonly manifestExists: (path: string) => Promise<boolean>;
  readonly resolveExtensionPath: () => string | null;
  readonly loadState: () => Promise<StateView>;
  readonly listConnections: () => readonly { readonly extensionId: string }[];
  /** The id the bundled extension's pinned manifest key resolves to (null if unkeyed/missing). */
  readonly deriveBundledExtensionId: () => Promise<string | null>;
  /** Debug ports of browsers this host launched, tagged sandbox vs existing-profile. */
  readonly listManagedPorts: () => readonly ManagedPort[];
  /** Extension ids of loaded service-worker targets on a debug port. */
  readonly fetchLoadedExtensionIds: (port: number) => Promise<readonly string[]>;
};

export const checkSetupCore = async (
  deps: CheckSetupDeps,
): Promise<ToolResponse> => {
  // Where chrome-devtools-mcp should attach: the active managed launch port if
  // one is live, otherwise the configured launch.defaultPort.
  const managedPorts = deps.listManagedPorts();
  const expectedPort = expectedCdpPort(managedPorts, deps.defaultPort());
  const expectedBrowserUrl = browserUrlFor(expectedPort);
  const cdpSnippet = cdpAddSnippet(expectedBrowserUrl);
  const cdpReg = await deps.readCdpRegistration();
  const installs = await deps.detectInstalls();
  const verifiable = installs.filter(
    (i): i is Extract<BrowserInstall, { kind: 'native' | 'snap' | 'flatpak' }> =>
      i.kind !== 'registry',
  );
  const manifestChecks = await Promise.all(
    verifiable.map(async (i) => ({
      browser: i.browser,
      ok: await deps.manifestExists(join(i.manifestDir, `${HOST_NAME}.json`)),
    })),
  );
  const anyManifest = manifestChecks.some((c) => c.ok);
  const extensionDist = deps.resolveExtensionPath();
  const state = await deps.loadState();
  const connections = deps.listConnections();

  const gaps: string[] = [];
  const recommendations: string[] = [];

  // chrome-devtools-mcp is a SEPARATE, OPTIONAL MCP the user registers with
  // Claude Code. Three states: not registered, registered but pointed at the
  // wrong debug port, or registered correctly. A registration change only takes
  // effect after a full Claude Code restart (MCP servers load at startup).
  const cdpRegPort = cdpPortOf(cdpReg.browserUrl);
  if (!cdpReg.registered) {
    gaps.push('chrome-devtools-mcp is not registered with Claude Code.');
    recommendations.push(
      `Register chrome-devtools-mcp (separate, optional MCP — runs via npx, no global install): \`${cdpSnippet}\`. A full Claude Code restart is required afterward for its tools to load.`,
    );
  } else if (cdpReg.browserUrl !== null && cdpRegPort !== expectedPort) {
    gaps.push(
      `chrome-devtools-mcp is registered but its --browserUrl (${cdpReg.browserUrl}) does not match the active debug port (${expectedBrowserUrl}); it will attach to the wrong browser or none.`,
    );
    recommendations.push(
      `Re-point chrome-devtools-mcp at the active port: \`claude mcp remove chrome-devtools\` then \`${cdpSnippet}\`, and restart Claude Code.`,
    );
  }
  if (installs.length === 0) {
    gaps.push('No Chromium-family browser install detected for the native messaging host.');
    recommendations.push(
      'Install Chrome, Brave, Chromium, or Edge, then run the host install.',
    );
  } else if (!anyManifest) {
    gaps.push('The native messaging host manifest is not installed for any detected browser.');
    recommendations.push(
      'Run `pwa-debug install` (or call host_register_extension with your extension ID) to write the per-browser manifest, then reload the extension at chrome://extensions.',
    );
  }
  if (!extensionDist) {
    gaps.push('The bundled pwa-debug extension dist was not found.');
    recommendations.push(
      'Build it (`pnpm --filter @pwa-debug/extension build`) or set PWA_DEBUG_EXTENSION_PATH. Call pdl_install_extension to copy it for unpacked install — or use pdl_launch_browser sandbox-persistent, which preloads it.',
    );
  }
  if (state.extensionIds.length === 0) {
    gaps.push('No extension ID is registered with the host.');
    recommendations.push(
      'Read the pwa-debug service-worker console for `[pwa-debug/sw] id=<id>` and call host_register_extension with that ID.',
    );
  }

  // Extension-id / allow-list consistency. A loaded extension whose id is not
  // in allowed_origins loads fine but Chrome rejects its connectNative — the
  // extension appears installed yet never connects. Catch it two ways.
  const registered = state.extensionIds;
  const bundledId = await deps.deriveBundledExtensionId();

  // Live: which ids are actually loaded in managed browsers, and where. In a
  // sandbox profile only our preloaded extension is present, so any unregistered
  // loaded id is a real problem; an existing profile also carries the user's own
  // extensions, so there we only flag the one matching our bundle.
  const probed = await Promise.all(
    managedPorts.map(async (m) => ({
      port: m.port,
      sandbox: m.sandbox,
      ids: await deps.fetchLoadedExtensionIds(m.port),
    })),
  );
  const loadedExtensionIds = [...new Set(probed.flatMap((p) => p.ids))];
  const mismatches = probed.flatMap((p) =>
    p.ids
      .filter((id) => !registered.includes(id))
      .filter((id) => p.sandbox || id === bundledId)
      .map((id) => ({ port: p.port, id })),
  );

  const firstMismatch = mismatches[0];
  if (firstMismatch) {
    const where = mismatches.map((m) => `${m.id} (port ${m.port})`).join(', ');
    gaps.push(
      `Extension(s) loaded in a managed browser are not whitelisted in the host's allowed_origins: ${where}. Chrome rejects their native-messaging connection, so they load but never connect.`,
    );
    const fixId =
      bundledId !== null && mismatches.some((m) => m.id === bundledId)
        ? bundledId
        : firstMismatch.id;
    recommendations.push(
      `Run host_register_extension ${fixId} (and host_unregister_extension on any stale id) so allowed_origins matches the loaded extension, then reload it at chrome://extensions.`,
    );
  } else if (
    bundledId !== null &&
    registered.length > 0 &&
    !registered.includes(bundledId)
  ) {
    // Static fallback: no managed browser was live to probe, but the bundled
    // extension's pinned id simply is not registered — it will fail to connect
    // the moment it loads.
    gaps.push(
      `The bundled extension's id (${bundledId}) is not registered with the host (registered: ${registered.join(', ')}). When it loads, Chrome will reject its native-messaging connection.`,
    );
    recommendations.push(
      `Run host_register_extension ${bundledId} (and host_unregister_extension on the stale id) before launching.`,
    );
  }

  const ok = gaps.length === 0;
  const data = {
    ok,
    gaps,
    recommendations,
    detail: {
      chromeDevtoolsMcp: {
        registered: cdpReg.registered,
        browserUrl: cdpReg.browserUrl,
        expectedBrowserUrl,
      },
      browserInstalls: installs.map((i) => i.browser),
      manifestInstalled: anyManifest,
      extensionDist,
      registeredExtensionIds: state.extensionIds.length,
      activeConnections: connections.length,
      bundledExtensionId: bundledId,
      loadedExtensionIds,
    },
  };

  const next_steps = ok
    ? [
        'Setup looks complete. Launch a browser with pdl_launch_browser, then call session_ping to confirm the page-world round-trip.',
      ]
    : recommendations;

  return okResponse(data, next_steps);
};

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

export const checkSetupHandler = async (
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<ToolResponse> =>
  checkSetupCore({
    readCdpRegistration: readChromeDevtoolsRegistration,
    defaultPort: () => ctx.settingsStore.getSetting('launch.defaultPort'),
    detectInstalls: () =>
      detectBrowserInstalls(process.env, process.platform, fileExists),
    manifestExists: fileExists,
    resolveExtensionPath: () => resolveExtensionPath(process.env),
    loadState: async () => {
      const state = await loadHostState(defaultStatePath());
      return { extensionIds: state.extensionIds };
    },
    listConnections: () => ctx.ipcServer.listConnections(),
    deriveBundledExtensionId: async () => {
      const dir = resolveExtensionPath(process.env);
      if (!dir) return null;
      return deriveBundledExtensionId(join(dir, 'manifest.json'), (p) =>
        readFile(p, 'utf8'),
      );
    },
    listManagedPorts: () =>
      getLaunchRegistry()
        .list()
        .map((l) => ({
          port: l.port,
          sandbox:
            l.profileType === 'sandbox-persistent' ||
            l.profileType === 'sandbox-temp',
        })),
    fetchLoadedExtensionIds,
  });

export const checkSetupTool: ToolDef<Record<string, never>> = Object.freeze({
  name: 'pdl_check_setup',
  description:
    'Diagnose pwa-debug + chrome-devtools-mcp setup and return { ok, gaps[], recommendations[], detail }. Checks: chrome-devtools-mcp registration (read from the `claude` CLI via `claude mcp get`) AND that its configured --browserUrl matches the active managed debug port (or launch.defaultPort) — flagging both not-registered and registered-at-the-wrong-port; native-messaging host manifest installed for a detected browser, bundled extension dist present, an extension ID registered, live NMH connections, AND extension-id / allow-list consistency — it derives the bundled extension\'s id from its pinned manifest key and probes any managed browser\'s debug port for loaded extension ids, flagging the case where an extension is loaded but its id is not whitelisted in allowed_origins (so it loads yet never connects). ok=true means no gaps. When gaps exist, next_steps carries the exact remediation (the `claude mcp add chrome-devtools …` snippet, the host install/register command, the host_register_extension <id> fix for a mismatch, or a pdl_install_extension pointer). detail also reports bundledExtensionId + loadedExtensionIds. Cheap, no side effects. Run this first on a new machine, then chain pdl_install_extension → pdl_launch_browser.',
  inputSchema,
  handler: checkSetupHandler,
});
