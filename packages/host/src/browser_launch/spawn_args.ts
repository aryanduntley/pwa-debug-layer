/**
 * Pure command-line builders for the launch actions, plus the CDP URL helper.
 * No effects — callers feed these into the injected spawnBrowser.
 */

export type SpawnArgs = {
  readonly cmd: string;
  readonly args: readonly string[];
};

/** CDP endpoint for a debug port. */
export const browserUrlFor = (port: number): string =>
  `http://127.0.0.1:${port}`;

/**
 * Chromium flags for a fresh launch — shared by the exec-by-path and flatpak
 * builders so the two command forms differ ONLY in the command prefix, never in
 * the flag set. --no-first-run / --no-default-browser-check keep it non-interactive.
 */
const freshFlags = (port: number, userDataDir: string): readonly string[] =>
  Object.freeze([
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]);

/**
 * Chromium flags for a sandbox launch (dedicated profile + preloaded extension).
 * Shared by the exec-by-path and flatpak builders. See buildSandboxSpawnArgs for
 * why the crash-restore-bubble suppressors are sandbox-only.
 */
const sandboxFlags = (
  port: number,
  userDataDir: string,
  extensionPath: string,
): readonly string[] =>
  Object.freeze([
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
  ]);

/**
 * Wrap chromium flags as a `flatpak run <app-id> <flags>` invocation. Used by
 * every flatpak builder; a flatpak browser has no host exec path, so it can only
 * be launched through `flatpak run`.
 *
 * NO `--` separator: `flatpak run`'s own options precede the app-id, and
 * everything after it is forwarded verbatim to the app. The org.chromium.Chromium
 * wrapper relays those args to chrome, so a literal `--` would reach chrome as
 * its end-of-switches marker — turning --remote-debugging-port etc. into
 * positional "URL" args and silently dropping the debug port. (Verified live
 * 2026-05-29: with `--` the port never binds; without it, it binds in ~1s.)
 */
const flatpakRun = (appId: string, browserFlags: readonly string[]): SpawnArgs =>
  Object.freeze({
    cmd: 'flatpak',
    args: Object.freeze(['run', appId, ...browserFlags]),
  });

/**
 * Fresh launch (sub-state c): bring up the debug port on the user's profile.
 */
export const buildFreshSpawnArgs = (
  execPath: string,
  port: number,
  userDataDir: string,
): SpawnArgs =>
  Object.freeze({ cmd: execPath, args: freshFlags(port, userDataDir) });

/** Fresh launch for a flatpak browser: `flatpak run <app-id> <fresh flags>`. */
export const buildFreshFlatpakArgs = (
  appId: string,
  port: number,
  userDataDir: string,
): SpawnArgs => flatpakRun(appId, freshFlags(port, userDataDir));

/**
 * New-window launch (sub-state b): re-invoke the binary so it opens a window
 * in the already-running session via IPC. No debug port — that requires a full
 * restart of the running process, which we never force.
 */
export const buildNewWindowArgs = (execPath: string): SpawnArgs =>
  Object.freeze({ cmd: execPath, args: Object.freeze(['--new-window']) });

/** New-window launch for a flatpak browser: `flatpak run <app-id> --new-window`. */
export const buildNewWindowFlatpakArgs = (appId: string): SpawnArgs =>
  flatpakRun(appId, Object.freeze(['--new-window']));

/**
 * Sandbox launch: dedicated profile + the pwa-debug extension preloaded BEFORE
 * any tab opens (so the content-script injection race cannot occur).
 * --disable-extensions-except pins the profile to only our extension.
 *
 * --disable-session-crashed-bubble + --hide-crash-restore-bubble suppress the
 * "Brave/Chrome didn't shut down correctly — restore tabs?" prompt on the NEXT
 * launch of this dedicated dev profile. The prompt is decided at startup from
 * the profile's exited_cleanly flag, NOT by how the browser was closed — so
 * this is the durable fix (works regardless of CDP close / SIGTERM / SIGKILL),
 * matching how Puppeteer / chrome-devtools-mcp launch their managed browsers.
 * Applied to sandbox modes only — an 'existing'-mode launch is the user's real
 * profile, where a genuine restore prompt should be left intact.
 */
export const buildSandboxSpawnArgs = (
  execPath: string,
  port: number,
  userDataDir: string,
  extensionPath: string,
): SpawnArgs =>
  Object.freeze({
    cmd: execPath,
    args: sandboxFlags(port, userDataDir, extensionPath),
  });

/**
 * Sandbox launch for a flatpak browser: `flatpak run <app-id> <sandbox flags>`.
 * NOTE: the dedicated --user-data-dir and --load-extension paths live on the
 * host filesystem, so the flatpak app needs host filesystem access
 * (`flatpak override --user --filesystem=host <app-id>`) for these to resolve
 * inside the sandbox — the same prerequisite the NMH path documents.
 */
export const buildSandboxFlatpakArgs = (
  appId: string,
  port: number,
  userDataDir: string,
  extensionPath: string,
): SpawnArgs => flatpakRun(appId, sandboxFlags(port, userDataDir, extensionPath));
