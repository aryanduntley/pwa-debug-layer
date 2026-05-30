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
    return Object.freeze({ ...base, action: 'attach' as const, pid: null });
  }

  // Confined browsers (flatpak + snap) search <user-data-dir>/NativeMessagingHosts/
  // for the host manifest, NOT the install location. Drop a copy there before
  // spawn so the SW's connectNative resolves the host. snapPackage routes the
  // manifest at the snap relay launcher; flatpak (appId) at the node launcher.
  // Native finds the manifest at the default config dir, so neither applies.
  if (input.appId || input.snapPackage) {
    await deps.writeSandboxManifest(input.userDataDir, input.snapPackage);
  }

  const { cmd, args } = input.appId
    ? buildSandboxFlatpakArgs(
        input.appId,
        input.port,
        input.userDataDir,
        input.extensionPath,
      )
    : buildSandboxSpawnArgs(
        input.execPath,
        input.port,
        input.userDataDir,
        input.extensionPath,
      );
  const { pid } = await deps.spawnBrowser(cmd, args);
  if (input.mode === 'sandbox-temp') {
    deps.registerTempProfile(input.userDataDir);
  }
  return Object.freeze({ ...base, action: 'spawn-fresh' as const, pid });
};
