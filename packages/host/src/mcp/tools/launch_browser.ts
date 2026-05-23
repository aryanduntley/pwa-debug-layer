import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { discoverBrowsers } from '../../browser_discovery/discover.js';
import { defaultDiscoveryDeps } from '../../browser_discovery/node_deps.js';
import type { BrowserDiscoveryResult } from '../../browser_discovery/types.js';
import { defaultUserDataDir } from '../../browser_launch/profile_dirs.js';
import {
  persistentProfileDir,
} from '../../browser_launch/sandbox_paths.js';
import { launchExisting } from '../../browser_launch/launch_existing.js';
import { launchSandbox } from '../../browser_launch/launch_sandbox.js';
import {
  defaultLaunchDeps,
  defaultSandboxDeps,
  getLaunchRegistry,
  makeTempProfileDir,
  resolveExtensionPath,
} from '../../browser_launch/node_deps.js';
import type {
  BrowserName,
  LaunchExistingInput,
  LaunchResult,
  LaunchSandboxInput,
  SandboxMode,
} from '../../browser_launch/types.js';

const BROWSERS = [
  'chrome',
  'chromium',
  'edge',
  'brave',
  'vivaldi',
  'opera',
] as const;

const MODES = ['existing', 'sandbox-persistent', 'sandbox-temp'] as const;

const inputSchema = {
  browser: z.enum(BROWSERS).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  mode: z.enum(MODES).optional(),
};

const isSandboxMode = (mode: string): mode is SandboxMode =>
  mode === 'sandbox-persistent' || mode === 'sandbox-temp';

/**
 * Injected effects for launchBrowserCore so the orchestration (target
 * resolution → profile/extension → launch → next_steps) is testable without
 * real discovery / fetch / spawn / fs.
 */
export type LaunchBrowserCoreDeps = {
  readonly discover: (
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
  ) => Promise<BrowserDiscoveryResult>;
  readonly resolveUserDataDir: (
    browser: BrowserName,
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    execPath?: string,
  ) => string | null;
  /** Default debug port when args.port is omitted (host launch.defaultPort setting). */
  readonly defaultPort: () => number;
  readonly launch: (input: LaunchExistingInput) => Promise<LaunchResult>;
  /** Sandbox profile dir (persistent deterministic; temp via mkdtemp). */
  readonly resolveSandboxProfileDir: (
    browser: BrowserName,
    mode: SandboxMode,
    env: NodeJS.ProcessEnv,
  ) => string | null;
  readonly resolveExtensionPath: (env: NodeJS.ProcessEnv) => string | null;
  readonly launchSandbox: (input: LaunchSandboxInput) => Promise<LaunchResult>;
  /** Record a successful launch (for pdl_browser_status). */
  readonly recordLaunch: (result: LaunchResult, port: number) => void;
};

const cdpHint = (browserUrl: string): string =>
  `Register chrome-devtools-mcp against it: \`claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl ${browserUrl}\`.`;

const nextStepsFor = (result: LaunchResult): string[] => {
  const sandbox = result.profileType !== 'existing';
  if (result.action === 'attach') {
    return [
      `Attached to the already-live debug port at ${result.browserUrl}${sandbox ? ` (${result.profileType} profile)` : ''}. ${cdpHint(result.browserUrl as string)}`,
    ];
  }
  if (result.action === 'spawn-fresh') {
    const steps = [
      `Spawned ${result.browser} (pid ${result.pid ?? 'unknown'}) with the debug port live at ${result.browserUrl}. ${cdpHint(result.browserUrl as string)}`,
    ];
    if (sandbox) {
      steps.push(
        `${result.profileType} profile at ${result.userDataDir} with the pwa-debug extension preloaded — no chrome://extensions reload needed.${result.profileType === 'sandbox-temp' ? ' This temp profile is removed on host shutdown.' : ' This profile persists across host restarts.'}`,
      );
    } else {
      steps.push(
        'If pwa-debug tools report no connection, ensure host_register_extension has run and reload the extension at chrome://extensions.',
      );
    }
    return steps;
  }
  // new-window (degraded; existing mode only)
  return [
    result.degradation ??
      'Opened a new window in the existing session; CDP tools are unavailable this run.',
    'pwa-debug tools (session_ping, console_tail, react_tree, …) work now. For CDP tools, fully quit the browser and re-run pdl_launch_browser, or use mode sandbox-persistent.',
  ];
};

/**
 * Pure-at-edges orchestration core: resolve the target browser (requested or
 * system default), then dispatch on mode — 'existing' attaches/launches the
 * user's profile (graceful triad); sandbox modes spawn a dedicated profile
 * with the extension preloaded. Effects arrive via deps.
 */
export const launchBrowserCore = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  deps: LaunchBrowserCoreDeps,
): Promise<ToolResponse> => {
  const port = args.port ?? deps.defaultPort();
  const mode = args.mode ?? 'existing';

  let discovery: BrowserDiscoveryResult;
  try {
    discovery = await deps.discover(platform, env);
  } catch (err) {
    return errorResponse(`browser discovery failed: ${(err as Error).message}`, [
      'Linux is the first-class target; macOS/Windows are deferred.',
    ]);
  }

  const target = args.browser
    ? discovery.browsers.find((b) => b.browser === args.browser)
    : discovery.defaultBrowser
      ? discovery.browsers.find((b) => b.browser === discovery.defaultBrowser)
      : discovery.browsers[0];

  if (!target) {
    const detected = discovery.browsers.map((b) => b.browser).join(', ') || 'none';
    return errorResponse(
      args.browser
        ? `Requested browser '${args.browser}' is not installed. Detected: ${detected}.`
        : `No Chromium-family browser detected to launch. Detected: ${detected}.`,
      ['Install a supported browser or pass an explicit `browser` from the detected list.'],
    );
  }

  if (isSandboxMode(mode)) {
    const userDataDir = deps.resolveSandboxProfileDir(target.browser, mode, env);
    if (!userDataDir) {
      return errorResponse(
        `Could not resolve a ${mode} profile dir for ${target.browser} on ${platform}.`,
        ['Linux is first-class; macOS/Windows sandbox profiles are deferred.'],
      );
    }
    const extensionPath = deps.resolveExtensionPath(env);
    if (!extensionPath) {
      return errorResponse(
        'Could not locate the pwa-debug extension to preload (no manifest.json found in any candidate path).',
        [
          'Build the extension (`pnpm --filter @pwa-debug/extension build`) or set PWA_DEBUG_EXTENSION_PATH to its unpacked dir. pdl_install_extension (M17) will bundle this automatically.',
        ],
      );
    }
    const result = await deps.launchSandbox({
      browser: target.browser,
      execPath: target.execPath,
      port,
      userDataDir,
      extensionPath,
      mode,
    });
    deps.recordLaunch(result, port);
    return okResponse(result, nextStepsFor(result));
  }

  // mode === 'existing'
  const userDataDir = deps.resolveUserDataDir(
    target.browser,
    platform,
    env,
    target.execPath,
  );
  if (!userDataDir) {
    return errorResponse(
      `Could not resolve the default user-data-dir for ${target.browser} on ${platform}.`,
      [
        'Linux native + snap profiles are handled; flatpak + macOS/Windows live verification is pending. Use sandbox-persistent mode as a workaround.',
      ],
    );
  }
  const result = await deps.launch({
    browser: target.browser,
    execPath: target.execPath,
    port,
    userDataDir,
  });
  deps.recordLaunch(result, port);
  return okResponse(result, nextStepsFor(result));
};

export const launchBrowserHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> =>
  launchBrowserCore(args, process.platform, process.env, {
    discover: (platform, env) =>
      discoverBrowsers(platform, env, defaultDiscoveryDeps()),
    resolveUserDataDir: defaultUserDataDir,
    defaultPort: () => ctx.settingsStore.getSetting('launch.defaultPort'),
    launch: (input) => launchExisting(input, defaultLaunchDeps()),
    resolveSandboxProfileDir: (browser, mode, env) =>
      mode === 'sandbox-temp'
        ? makeTempProfileDir()
        : persistentProfileDir(browser, env),
    resolveExtensionPath,
    launchSandbox: (input) => launchSandbox(input, defaultSandboxDeps()),
    recordLaunch: (result, port) =>
      getLaunchRegistry().record({
        browser: result.browser,
        profileType: result.profileType,
        port,
        pid: result.pid,
        browserUrl: result.browserUrl,
        ...(result.userDataDir !== undefined
          ? { userDataDir: result.userDataDir }
          : {}),
      }),
  });

export const launchBrowserTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'pdl_launch_browser',
  description:
    "Launch or attach to a Chromium-family browser with a live remote-debugging port, for use alongside chrome-devtools-mcp. Modes: mode='existing' (default) targets the user's normal profile and degrades gracefully — (a) port already live → attach; (b) running without a debug port → opens a NEW WINDOW in the existing session (never kills it), attached:false + degradation message; (c) not running → spawns fresh with --remote-debugging-port + --user-data-dir=<your profile>. mode='sandbox-persistent' spawns a dedicated, persistent dev profile at ~/.pwa-debug/profiles/<browser>/ beside your normal browser, with the pwa-debug extension PRELOADED (no reload needed); mode='sandbox-temp' is the same but in a throwaway mkdtemp profile cleaned up on host shutdown. Sandbox modes always work standalone (separate profile → no lock collision) and both pwa-debug + CDP tools are available. Args: browser? (chrome|chromium|edge|brave|vivaldi|opera; defaults to system-default), port? (default 9222), mode?. Linux is first-class; macOS/Windows deferred. Follow next_steps[] — it carries the chrome-devtools-mcp registration snippet, the profile location, or the degradation guidance.",
  inputSchema,
  handler: launchBrowserHandler,
});
