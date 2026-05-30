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
};

/** Inputs for a sandbox-mode launch (dedicated profile + preloaded extension). */
export type LaunchSandboxInput = {
  readonly browser: BrowserName;
  readonly execPath: string;
  readonly port: number;
  readonly userDataDir: string;
  /** Unpacked extension dir passed to --load-extension / --disable-extensions-except. */
  readonly extensionPath: string;
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
   * Confined-browser only: write the NMH manifest into
   * `<userDataDir>/NativeMessagingHosts/` before spawn, because a flatpak/snap
   * Chromium launched with a custom --user-data-dir searches THAT dir (not the
   * install location). When snapPackage is given the manifest points at the
   * SNAP relay launcher (and ensures the relay files exist); otherwise (flatpak)
   * it points at the canonical node launcher. Native finds the manifest at the
   * default config location, so the launch flow only invokes this for
   * flatpak (appId) or snap (snapPackage).
   */
  readonly writeSandboxManifest: (
    userDataDir: string,
    snapPackage?: string,
  ) => Promise<void>;
};
