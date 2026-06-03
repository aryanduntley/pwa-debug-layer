/**
 * Sandbox-mode launch: spawn a dedicated-profile browser process with the
 * pwa-debug extension preloaded, beside the user's normal browser.
 *
 * No triad — a sandbox always uses its own --user-data-dir, so there is no
 * profile-lock collision and no "running without a port" middle state. We only
 * probe our own port to stay idempotent: if our sandbox is already up, attach;
 * otherwise spawn. sandbox-temp additionally registers its dir for shutdown
 * cleanup.
 */
import {
  browserUrlFor,
  buildSandboxFlatpakArgs,
  buildSandboxSpawnArgs,
} from './spawn_args.js';
import type {
  LaunchResult,
  LaunchSandboxDeps,
  LaunchSandboxInput,
} from './types.js';

export const launchSandbox = async (
  input: LaunchSandboxInput,
  deps: LaunchSandboxDeps,
): Promise<LaunchResult> => {
  const base = {
    ok: true as const,
    browser: input.browser,
    browserUrl: browserUrlFor(input.port),
    profileType: input.mode,
    attached: true as const,
    userDataDir: input.userDataDir,
  };

  if (await deps.probeDebugPort(input.port)) {
    // Attaching to an already-live sandbox-persistent profile: it may be serving
    // stale extension code from before a rebuild, so refresh on request (#318).
    if (input.refreshExtension) await deps.refreshExtension(input.port);
    return Object.freeze({ ...base, action: 'attach' as const, pid: null });
  }

  // ANY Chromium launched with a custom --user-data-dir (which every sandbox
  // mode is) searches <user-data-dir>/NativeMessagingHosts/ for the host
  // manifest — NOT the install-location config dir. This holds for native
  // browsers too (FINDING #3): a native sandbox never inherits the default
  // profile's manifest, so its SW connectNative fails silently without this.
  // Drop a copy into the sandbox profile before spawn. snapPackage routes the
  // manifest at the snap relay launcher; flatpak/native at the node launcher.
  await deps.writeSandboxManifest(input.userDataDir, input.snapPackage);

  // A fresh sandbox profile has Developer Mode OFF, which makes a flatpak Chromium
  // refuse the unpacked --load-extension (#318). Seed developer_mode=true into the
  // profile's Preferences before spawn so the extension loads with no manual step.
  await deps.seedDeveloperMode(input.userDataDir);

  const { cmd, args } = input.appId
    ? buildSandboxFlatpakArgs(
        input.appId,
        input.port,
        input.userDataDir,
        input.extensionPath,
        input.loadStrategy,
      )
    : buildSandboxSpawnArgs(
        input.execPath,
        input.port,
        input.userDataDir,
        input.extensionPath,
        input.loadStrategy,
      );
  const { pid } = await deps.spawnBrowser(cmd, args);
  if (input.mode === 'sandbox-temp') {
    deps.registerTempProfile(input.userDataDir);
  }
  // On a sandbox-persistent relaunch the profile can serve cached extension code,
  // so a refresh re-reads the rebuilt source once the port + SW come up. The
  // effect polls the port itself, tolerating the not-yet-bound spawn (#318).
  if (input.refreshExtension) await deps.refreshExtension(input.port);
  const spawned = { ...base, action: 'spawn-fresh' as const, pid };
  // manual-guided (branded Google Chrome >=142): the extension was NOT
  // preloaded — the CDP port is live but pwa-debug stays disconnected until the
  // user completes a one-time Load-unpack. Flag it; launch_browser's next_steps
  // carries the step-by-step. The per-profile manifest is already written above,
  // so connectNative succeeds the moment the extension is loaded.
  return Object.freeze(
    input.loadStrategy === 'manual-guided'
      ? {
          ...spawned,
          degradation:
            'The pwa-debug extension was NOT auto-loaded (branded Google Chrome >=142 ignores --load-extension). The debug port is live for chrome-devtools-mcp, but pwa-debug tools stay disconnected until the extension is loaded manually.',
        }
      : spawned,
  );
};
