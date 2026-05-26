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
 * Fresh launch (sub-state c): bring up the debug port on the user's profile.
 * --no-first-run / --no-default-browser-check keep the spawn non-interactive.
 */
export const buildFreshSpawnArgs = (
  execPath: string,
  port: number,
  userDataDir: string,
): SpawnArgs =>
  Object.freeze({
    cmd: execPath,
    args: Object.freeze([
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]),
  });

/**
 * New-window launch (sub-state b): re-invoke the binary so it opens a window
 * in the already-running session via IPC. No debug port — that requires a full
 * restart of the running process, which we never force.
 */
export const buildNewWindowArgs = (execPath: string): SpawnArgs =>
  Object.freeze({ cmd: execPath, args: Object.freeze(['--new-window']) });

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
    args: Object.freeze([
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${extensionPath}`,
      `--disable-extensions-except=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
    ]),
  });
