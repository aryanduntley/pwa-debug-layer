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
import type {
  BrowserDiscoveryResult,
  DiscoveredBrowser,
  Packaging,
} from '../../browser_discovery/types.js';
import { defaultUserDataDir } from '../../browser_launch/profile_dirs.js';
import { launchExisting } from '../../browser_launch/launch_existing.js';
import { launchSandbox } from '../../browser_launch/launch_sandbox.js';
import { snapPackageForBrowser } from '../../native-messaging/snap_host.js';
import {
  defaultLaunchDeps,
  defaultSandboxDeps,
  getLaunchRegistry,
  resolveSandboxProfileDir,
  resolveExtensionPath,
  readTargetBrowserVersion,
} from '../../browser_launch/node_deps.js';
import {
  extensionLoadStrategy,
  type BrowserVersion,
} from '../../browser_launch/extension_load.js';
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

const PACKAGINGS = ['native', 'snap', 'flatpak'] as const;

const inputSchema = {
  browser: z.enum(BROWSERS).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  mode: z.enum(MODES).optional(),
  packaging: z.enum(PACKAGINGS).optional(),
};

const isSandboxMode = (mode: string): mode is SandboxMode =>
  mode === 'sandbox-persistent' || mode === 'sandbox-temp';

/** Tiebreak order when several packagings of the requested browser exist and the
 *  caller did not pin one: prefer a normal system install, then snap, then flatpak. */
const PACKAGING_PREFERENCE: Record<Packaging, number> = {
  native: 0,
  snap: 1,
  flatpak: 2,
};

/**
 * Pure target selection. Resolves the requested (or system-default, or first)
 * browser NAME, optionally narrows to a requested packaging, and tiebreaks by
 * PACKAGING_PREFERENCE. Also reports the OTHER packagings of the chosen browser
 * so the caller can tell the user/AI it could re-target (e.g. snap vs flatpak).
 */
const resolveTarget = (
  discovery: BrowserDiscoveryResult,
  requested: BrowserName | undefined,
  packaging: Packaging | undefined,
): {
  readonly target: DiscoveredBrowser | undefined;
  readonly alternatives: readonly Packaging[];
} => {
  const name =
    requested ?? discovery.defaultBrowser ?? discovery.browsers[0]?.browser;
  const sameBrowser = discovery.browsers.filter((b) => b.browser === name);
  const filtered = packaging
    ? sameBrowser.filter((b) => b.packaging === packaging)
    : sameBrowser;
  const target = [...filtered].sort(
    (a, b) => PACKAGING_PREFERENCE[a.packaging] - PACKAGING_PREFERENCE[b.packaging],
  )[0];
  const alternatives = target
    ? [
        ...new Set(
          sameBrowser
            .filter((b) => b.packaging !== target.packaging)
            .map((b) => b.packaging),
        ),
      ]
    : [];
  return { target, alternatives };
};

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
  /** Sandbox profile dir (persistent deterministic; temp via mkdtemp). Snap
   *  browsers route to a snap-common dir (~/.pwa-debug is unreachable in snap
   *  confinement), so packaging is required to pick the right base. */
  readonly resolveSandboxProfileDir: (
    browser: BrowserName,
    mode: SandboxMode,
    packaging: Packaging,
    env: NodeJS.ProcessEnv,
  ) => string | null;
  readonly resolveExtensionPath: (env: NodeJS.ProcessEnv) => string | null;
  /** Read the target's brand+version so the extension-load strategy can branch
   *  (branded Google Chrome >=142 can't preload via --load-extension). null when
   *  the version can't be read → caller falls back to the optimistic flag path. */
  readonly readVersion: (
    target: DiscoveredBrowser,
  ) => Promise<BrowserVersion | null>;
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
      const lifetime =
        result.profileType === 'sandbox-temp'
          ? ' This temp profile is removed on host shutdown.'
          : ' This profile persists across host restarts.';
      // When the launch degraded (manual-guided: branded Chrome >=142 couldn't
      // preload the extension), don't claim it's preloaded — the detailed manual
      // Load-unpack guidance is appended separately by launchOk.
      steps.push(
        result.degradation
          ? `${result.profileType} profile at ${result.userDataDir}.${lifetime} ${result.degradation}`
          : `${result.profileType} profile at ${result.userDataDir} with the pwa-debug extension preloaded — no chrome://extensions reload needed.${lifetime}`,
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
 * Flatpak-only onboarding guidance. A flatpak-sandboxed Chromium needs three
 * user actions the host cannot perform programmatically: (1) Developer Mode ON
 * at chrome://extensions, or the --load-extension unpacked extension is disabled
 * on each start; (2) the extension's debug toggle, since its native-messaging
 * connection is user-initiated (the MV3 SW only opens the host port on demand);
 * (3) the host filesystem override so the sandboxed NMH can reach the launcher +
 * IPC socket. Surfaced as a next_step so the AI relays it verbatim — without it
 * pwa-debug tools silently report "no connection" on flatpak.
 */
const flatpakLaunchGuidance = (browser: string, appId: string): string =>
  `${browser} is a flatpak app (${appId}). For the pwa-debug extension to load AND connect, the user must: (1) open chrome://extensions and turn ON Developer Mode (top-right) — a flatpak Chromium disables --load-extension unpacked extensions without it; (2) enable the pwa-debug extension's debug toggle — its native connection is user-initiated, so host_status/session_ping show "no connection" until then; (3) ensure \`flatpak override --user --filesystem=host ${appId}\` has been applied so the sandboxed native host can reach the launcher and IPC socket. Relay these three steps to the user.`;

/**
 * Manual-provisioning guidance for branded Google Chrome 142+, where
 * --load-extension is permanently removed (no flag/policy loads an UNPACKED
 * extension). The browser is up with a live debug port, but the pwa-debug
 * extension must be loaded by hand once. Surfaced as a next_step so the AI walks
 * the user through it; the dir is the resolved unpacked extension path. The
 * per-profile NMH manifest is already written, so the extension connects to the
 * host the instant it loads — no further host step.
 */
const manualLoadUnpackGuidance = (
  browser: string,
  extensionPath: string,
): string =>
  `${browser} is branded Google Chrome 142+ — it permanently ignores --load-extension, and enterprise policy can't force-install an unpacked extension, so the pwa-debug extension was NOT auto-loaded (chrome-devtools-mcp still works via the live debug port). Walk the user through a one-time manual load: (1) open chrome://extensions in the launched window; (2) toggle ON "Developer mode" (top-right); (3) click "Load unpacked" and select \`${extensionPath}\`. It persists in this dedicated profile across restarts, and connects to the host immediately (the native-messaging manifest is already in place). Alternatively, re-run pdl_launch_browser with browser=brave (or chromium), where --load-extension still works and the extension preloads automatically.`;

/** Tell the AI/user the chosen browser is also installed under other packagings,
 *  so they can re-target — e.g. snap was launched but flatpak is available too. */
const packagingChoiceHint = (
  target: DiscoveredBrowser,
  alternatives: readonly Packaging[],
): string =>
  `${target.browser} is also installed as: ${alternatives.join(', ')}. Launched the '${target.packaging}' packaging (default preference native > snap > flatpak). To target a different one, re-run pdl_launch_browser with packaging='${alternatives[0]}'.`;

/**
 * okResponse + selection-aware next_steps: a flatpak onboarding step when the
 * target is a flatpak app, and a packaging-choice step when the chosen browser
 * is also installed under other packagings (and none was explicitly requested).
 */
const launchOk = (
  result: LaunchResult,
  target: DiscoveredBrowser,
  alternatives: readonly Packaging[],
  packagingRequested: boolean,
  manualGuided?: { readonly extensionPath: string },
): ToolResponse => {
  const steps = nextStepsFor(result);
  // Manual provisioning takes priority in the guidance order — it's the reason
  // pwa-debug won't connect yet, so the AI should relay it first.
  if (manualGuided) {
    steps.push(manualLoadUnpackGuidance(target.browser, manualGuided.extensionPath));
  }
  if (target.source === 'flatpak' && target.appId) {
    steps.push(flatpakLaunchGuidance(target.browser, target.appId));
  }
  if (!packagingRequested && alternatives.length > 0) {
    steps.push(packagingChoiceHint(target, alternatives));
  }
  return okResponse(result, steps);
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

  const { target, alternatives } = resolveTarget(
    discovery,
    args.browser,
    args.packaging,
  );

  if (!target) {
    const detected =
      discovery.browsers
        .map((b) => `${b.browser}[${b.packaging}]`)
        .join(', ') || 'none';
    const msg = args.packaging
      ? `No '${args.browser ?? 'default'}' browser with packaging '${args.packaging}' found. Detected: ${detected}.`
      : args.browser
        ? `Requested browser '${args.browser}' is not installed. Detected: ${detected}.`
        : `No Chromium-family browser detected to launch. Detected: ${detected}.`;
    return errorResponse(msg, [
      'Install a supported browser, or pass an explicit `browser` (and optional `packaging`: native|snap|flatpak) from the detected list.',
    ]);
  }

  if (isSandboxMode(mode)) {
    const userDataDir = deps.resolveSandboxProfileDir(
      target.browser,
      mode,
      target.packaging,
      env,
    );
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
    const snapPkg =
      target.packaging === 'snap'
        ? snapPackageForBrowser(target.browser)
        : null;
    // Resolve the extension-load strategy from the target's brand+version.
    // Branded Google Chrome >=142 can't preload via --load-extension, so the
    // launch comes up without the extension and steers to a manual Load-unpack.
    const loadStrategy = extensionLoadStrategy(await deps.readVersion(target));
    const result = await deps.launchSandbox({
      browser: target.browser,
      execPath: target.execPath,
      port,
      userDataDir,
      extensionPath,
      loadStrategy,
      mode,
      ...(target.appId !== undefined ? { appId: target.appId } : {}),
      ...(snapPkg ? { snapPackage: snapPkg } : {}),
    });
    deps.recordLaunch(result, port);
    return launchOk(
      result,
      target,
      alternatives,
      args.packaging !== undefined,
      loadStrategy === 'manual-guided' ? { extensionPath } : undefined,
    );
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
        'Linux native, snap, and flatpak profiles are handled; macOS/Windows live verification is pending. Use sandbox-persistent mode as a workaround.',
      ],
    );
  }
  const result = await deps.launch({
    browser: target.browser,
    execPath: target.execPath,
    port,
    userDataDir,
    ...(target.appId !== undefined ? { appId: target.appId } : {}),
  });
  deps.recordLaunch(result, port);
  return launchOk(result, target, alternatives, args.packaging !== undefined);
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
    resolveSandboxProfileDir,
    resolveExtensionPath,
    readVersion: readTargetBrowserVersion,
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
    "Launch or attach to a Chromium-family browser with a live remote-debugging port, for use alongside chrome-devtools-mcp. Modes: mode='existing' (default) targets the user's normal profile and degrades gracefully — (a) port already live → attach; (b) running without a debug port → opens a NEW WINDOW in the existing session (never kills it), attached:false + degradation message; (c) not running → spawns fresh with --remote-debugging-port + --user-data-dir=<your profile>. mode='sandbox-persistent' spawns a dedicated, persistent dev profile at ~/.pwa-debug/profiles/<browser>/ beside your normal browser, with the pwa-debug extension PRELOADED (no reload needed); mode='sandbox-temp' is the same but in a throwaway mkdtemp profile cleaned up on host shutdown. Sandbox modes always work standalone (separate profile → no lock collision) and both pwa-debug + CDP tools are available. Args: browser? (chrome|chromium|edge|brave|vivaldi|opera; defaults to system-default), port? (default 9222), mode?, packaging? (native|snap|flatpak). When the same browser is installed under multiple packagings (e.g. snap AND flatpak chromium), pass packaging to pick one; without it the default preference is native > snap > flatpak and next_steps lists the alternatives so you can re-target. Linux is first-class; macOS/Windows deferred. Follow next_steps[] — it carries the chrome-devtools-mcp registration snippet, the profile location, the flatpak onboarding steps, or the degradation guidance.",
  inputSchema,
  handler: launchBrowserHandler,
});
