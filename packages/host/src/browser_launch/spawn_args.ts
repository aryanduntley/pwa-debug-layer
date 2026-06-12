/**
 * Pure command-line builders for the launch actions, plus the CDP URL helper.
 * No effects — callers feed these into the injected spawnBrowser.
 */
import type { ExtensionLoadStrategy } from './extension_load.js';

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
 *
 * The extension-preload flags vary by ExtensionLoadStrategy (see extension_load):
 *  - 'load-flag': --load-extension + --disable-extensions-except (the norm).
 *  - 'load-flag-escape-hatch': the same PLUS
 *    --disable-features=DisableLoadExtensionCommandLineSwitch, which re-enables
 *    --load-extension on branded Google Chrome 137..141.
 *  - 'manual-guided': NEITHER flag — branded Google Chrome >=142 ignores
 *    --load-extension, and --disable-extensions-except would additionally block
 *    the manual Load-unpack the user is steered to. The profile/port still come
 *    up; the extension is provisioned by hand afterward.
 *
 * `isolate` (default true) controls --disable-extensions-except, which pins the
 * profile to ONLY pwa-debug — Chromium disables every other extension, including
 * ones already in the persistent profile or Load-unpacked/installed after launch.
 * Pass false to drop it so other extensions coexist: --load-extension still
 * preloads pwa-debug, while the profile's other extensions stay enabled. No-op
 * under 'manual-guided' (the flag is already omitted there).
 */
const sandboxFlags = (
  port: number,
  userDataDir: string,
  extensionPath: string,
  strategy: ExtensionLoadStrategy,
  isolate: boolean,
): readonly string[] => {
  const extensionFlags =
    strategy === 'manual-guided'
      ? []
      : [
          `--load-extension=${extensionPath}`,
          ...(isolate ? [`--disable-extensions-except=${extensionPath}`] : []),
          ...(strategy === 'load-flag-escape-hatch'
            ? ['--disable-features=DisableLoadExtensionCommandLineSwitch']
            : []),
        ];
  return Object.freeze([
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...extensionFlags,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
  ]);
};

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
 * --disable-extensions-except pins the profile to only our extension when
 * `isolate` is true (the default); pass false to let other extensions coexist.
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
  strategy: ExtensionLoadStrategy,
  isolate = true,
): SpawnArgs =>
  Object.freeze({
    cmd: execPath,
    args: sandboxFlags(port, userDataDir, extensionPath, strategy, isolate),
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
  strategy: ExtensionLoadStrategy,
  isolate = true,
): SpawnArgs =>
  flatpakRun(
    appId,
    sandboxFlags(port, userDataDir, extensionPath, strategy, isolate),
  );
