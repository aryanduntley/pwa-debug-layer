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
import { browserUrlFor, buildSandboxSpawnArgs } from './spawn_args.js';
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

  const { cmd, args } = buildSandboxSpawnArgs(
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
