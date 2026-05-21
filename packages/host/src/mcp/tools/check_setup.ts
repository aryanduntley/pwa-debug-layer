import { stat } from 'node:fs/promises';
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
  probeChromeDevtoolsVersion,
  resolveExtensionPath,
} from '../../browser_launch/node_deps.js';

const inputSchema = {} as Record<string, never>;

const HOST_NAME = 'com.pwa_debug.host';

type StateView = { readonly extensionIds: readonly string[] };

/** Injected probes so the gap analysis is testable without npx / fs / state. */
export type CheckSetupDeps = {
  readonly probeChromeDevtools: () => Promise<boolean>;
  readonly detectInstalls: () => Promise<readonly BrowserInstall[]>;
  readonly manifestExists: (path: string) => Promise<boolean>;
  readonly resolveExtensionPath: () => string | null;
  readonly loadState: () => Promise<StateView>;
  readonly listConnections: () => readonly { readonly extensionId: string }[];
};

const CDP_SNIPPET =
  'claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222';

export const checkSetupCore = async (
  deps: CheckSetupDeps,
): Promise<ToolResponse> => {
  const cdpOk = await deps.probeChromeDevtools();
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

  if (!cdpOk) {
    gaps.push('chrome-devtools-mcp is not available (npx probe failed).');
    recommendations.push(
      `Register chrome-devtools-mcp (it runs via npx, no global install needed): \`${CDP_SNIPPET}\`.`,
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

  const ok = gaps.length === 0;
  const data = {
    ok,
    gaps,
    recommendations,
    detail: {
      chromeDevtoolsMcp: cdpOk,
      browserInstalls: installs.map((i) => i.browser),
      manifestInstalled: anyManifest,
      extensionDist,
      registeredExtensionIds: state.extensionIds.length,
      activeConnections: connections.length,
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
    probeChromeDevtools: probeChromeDevtoolsVersion,
    detectInstalls: () =>
      detectBrowserInstalls(process.env, process.platform, fileExists),
    manifestExists: fileExists,
    resolveExtensionPath: () => resolveExtensionPath(process.env),
    loadState: async () => {
      const state = await loadHostState(defaultStatePath());
      return { extensionIds: state.extensionIds };
    },
    listConnections: () => ctx.ipcServer.listConnections(),
  });

export const checkSetupTool: ToolDef<Record<string, never>> = Object.freeze({
  name: 'pdl_check_setup',
  description:
    'Diagnose pwa-debug + chrome-devtools-mcp setup and return { ok, gaps[], recommendations[], detail }. Checks: chrome-devtools-mcp availability (npx probe), native-messaging host manifest installed for a detected browser, bundled extension dist present, an extension ID registered, and live NMH connections. ok=true means no gaps. When gaps exist, next_steps carries the exact remediation (the `claude mcp add chrome-devtools …` snippet, the host install/register command, or a pdl_install_extension pointer). Cheap, no side effects. Run this first on a new machine, then chain pdl_install_extension → pdl_launch_browser.',
  inputSchema,
  handler: checkSetupHandler,
});
