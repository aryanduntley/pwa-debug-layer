/**
 * Browser-launch vocabulary.
 *
 * browser_launch decides how to make a Chromium-family browser available with
 * a live remote-debugging port, degrading gracefully across runtime states.
 * M15 implements the 'existing' profile mode (user's normal profile); the
 * sandbox modes are reserved in LaunchProfileType for M16.
 *
 * The triad decision (run_state) and spawn-arg construction (spawn_args) are
 * pure; every effect (debug-port probe, process check, process spawn) is
 * injected via LaunchDeps and isolated in node_deps.ts. Reuses BrowserName
 * from native_messaging — one browser vocabulary, never redefined.
 */
import type { BrowserName } from '../native-messaging/browser_paths.js';
import type { ExtensionLoadStrategy } from './extension_load.js';

export type { BrowserName };

/** Which profile a launch targets. Only 'existing' is implemented in M15. */
export type LaunchProfileType =
  | 'existing'
  | 'sandbox-persistent'
  | 'sandbox-temp';

/** Runtime state of the target browser, derived from probe + process checks. */
export type BrowserRunState =
  /** Debug port is live and answering — attach directly. */
  | 'port-live'
  /** Browser process is up but no debug port — can only open a new window. */
  | 'running-no-port'
  /** Browser is not running — free to spawn fresh with the debug port. */
  | 'not-running';

/** The action chosen for a run state. */
export type LaunchAction = 'attach' | 'new-window' | 'spawn-fresh';

/** The two dedicated-profile modes (separate process from the user's browser). */
export type SandboxMode = 'sandbox-persistent' | 'sandbox-temp';

/** Outcome of spawning a process. */
export type SpawnOutcome = { readonly pid: number | null };

/** Result of an 'existing'-mode launch attempt. */
export type LaunchResult = {
  readonly ok: boolean;
  readonly browser: BrowserName;
  /** CDP endpoint when a debug port is live, else null. */
  readonly browserUrl: string | null;
  readonly profileType: LaunchProfileType;
  /** True when chrome-devtools-mcp (CDP) can attach this run. */
  readonly attached: boolean;
  readonly action: LaunchAction;
  readonly pid: number | null;
  /** The profile dir used (sandbox modes report it; existing mode omits it). */
  readonly userDataDir?: string;
  /** Present only when degraded (new-window): explains the CDP limitation. */
  readonly degradation?: string;
};

/** Injected effects so launch logic stays pure + testable. */
export type LaunchDeps = {
  /** True when GET http://127.0.0.1:<port>/json/version answers. */
  readonly probeDebugPort: (port: number) => Promise<boolean>;
  /** True when a process for this browser executable is running. */
  readonly isProcessRunning: (
    browser: BrowserName,
    execPath: string,
  ) => Promise<boolean>;
  /** Spawn the browser detached; resolve its pid (or null if unknown). */
  readonly spawnBrowser: (
    cmd: string,
    args: readonly string[],
  ) => Promise<SpawnOutcome>;
};

/** Inputs for an 'existing'-mode launch. */
export type LaunchExistingInput = {
  readonly browser: BrowserName;
  readonly execPath: string;
  readonly port: number;
  readonly userDataDir: string;
  /**
   * Flatpak app-id when the target is a flatpak browser. When set, spawns use
   * the `flatpak run <app-id> …` command form instead of exec-by-path
   * (execPath is the app-id, not a host binary, for flatpak targets).
   */
  readonly appId?: string;
  /**
   * True when this browser refuses --remote-debugging-port on the default
   * profile (Chromium >=136). A spawn-fresh existing-mode launch then comes up
   * WITHOUT a usable debug port, so the result degrades (browserUrl null,
   * attached false) and steers to sandbox-persistent rather than reporting a
   * port that never listens. Resolved by the orchestrator from the target's
   * version via debugPortBlockedOnDefaultProfile.
   */
  readonly debugPortBlockedOnDefaultProfile: boolean;
};

/** Inputs for a sandbox-mode launch (dedicated profile + preloaded extension). */
export type LaunchSandboxInput = {
  readonly browser: BrowserName;
  readonly execPath: string;
  readonly port: number;
  readonly userDataDir: string;
  /** Unpacked extension dir passed to --load-extension / --disable-extensions-except. */
  readonly extensionPath: string;
  /**
   * How to provision the extension for THIS browser (resolved from its
   * brand+version): 'load-flag' / 'load-flag-escape-hatch' use --load-extension;
   * 'manual-guided' (branded Google Chrome >=142) omits it and the launch
   * returns a degradation steering the user to a manual Load-unpack.
   */
  readonly loadStrategy: ExtensionLoadStrategy;
  readonly mode: SandboxMode;
  /** Flatpak app-id when the target is a flatpak browser (see LaunchExistingInput.appId). */
  readonly appId?: string;
  /**
   * Snap package name when the target is a snap browser. Present => the launch
   * writes a SNAP manifest (pointing at the snap relay launcher) into the
   * sandbox profile's NativeMessagingHosts/, since a snap Chromium with a
   * custom --user-data-dir searches there. Mutually exclusive with appId.
   */
  readonly snapPackage?: string;
  /**
   * When true (sandbox-persistent only), force an extension reload once the
   * debug port is live so a rebuild's new code is served (note 318). Set by the
   * pdl_launch_browser handler from PWA_DEBUG_REFRESH_EXTENSION — OFF by default,
   * so end-user launches are unchanged; this is dev/AI re-verification ergonomics.
   */
  readonly refreshExtension?: boolean;
  /**
   * Pin the sandbox profile to ONLY pwa-debug via --disable-extensions-except.
   * Defaults to true (clean-room debugging: no other extension can interfere).
   * Set false to let other extensions coexist — pwa-debug still preloads via
   * --load-extension, while extensions already in the profile (sandbox-persistent)
   * or Load-unpacked/installed after launch stay enabled. No effect under the
   * manual-guided strategy, which omits the flag regardless.
   */
  readonly isolateExtensions?: boolean;
};

/**
 * Effects for a sandbox launch: probe + spawn (shared with LaunchDeps) plus a
 * sink to register a temp profile dir for shutdown cleanup. No process check —
 * a sandbox always uses its own profile, so it can spawn beside the main browser.
 */
export type LaunchSandboxDeps = Pick<
  LaunchDeps,
  'probeDebugPort' | 'spawnBrowser'
> & {
  readonly registerTempProfile: (dir: string) => void;
  /**
   * Write the NMH manifest into `<userDataDir>/NativeMessagingHosts/` before
   * spawn. EVERY sandbox launch needs this — any Chromium with a custom
   * --user-data-dir (native, flatpak, or snap) searches that dir for the host
   * manifest, not the install location (FINDING #3: a native sandbox does NOT
   * inherit the default profile's manifest). When snapPackage is given the
   * manifest points at the SNAP relay launcher (and ensures the relay files
   * exist); otherwise (native/flatpak) it points at the canonical node launcher.
   */
  readonly writeSandboxManifest: (
    userDataDir: string,
    snapPackage?: string,
  ) => Promise<void>;
  /**
   * Seed `<userDataDir>/Default/Preferences` with
   * extensions.ui.developer_mode=true BEFORE spawn, so a fresh sandbox profile
   * honors --load-extension without a manual Developer-Mode toggle (note 318: a
   * flatpak Chromium disables unpacked --load-extension when dev mode is off).
   * Non-destructive (merges into existing prefs); best-effort (never throws).
   */
  readonly seedDeveloperMode: (userDataDir: string) => Promise<void>;
  /**
   * Force the loaded pwa-debug extension to reload (chrome.runtime.reload() over
   * the SW's CDP websocket) so a rebuild's new page-world/SW code is served on a
   * sandbox-persistent relaunch (note 318: the profile otherwise caches stale
   * extension code). Polls the debug port for the extension SW first. Resolves
   * true when a reload was issued, false otherwise; never throws.
   */
  readonly refreshExtension: (port: number) => Promise<boolean>;
};
