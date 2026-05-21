/**
 * 'existing'-mode launch: the graceful-degradation triad orchestrated over the
 * pure run_state decision + spawn_args builders, with all effects injected.
 *
 *   (a) port-live      → attach (no spawn)        attached=true,  browserUrl set
 *   (b) running-no-port → open a new window        attached=false, browserUrl null, degradation
 *   (c) not-running     → spawn fresh with debug   attached=true,  browserUrl set
 */
import { classifyRunState, chooseLaunchAction } from './run_state.js';
import {
  browserUrlFor,
  buildFreshSpawnArgs,
  buildNewWindowArgs,
} from './spawn_args.js';
import type {
  LaunchDeps,
  LaunchExistingInput,
  LaunchResult,
} from './types.js';

const degradationMessage = (browser: string): string =>
  `${browser} is already running without a remote-debugging port. Opened a new window in your existing session — pwa-debug extension tools work, but chrome-devtools-mcp (CDP) tools are unavailable this run. To enable CDP, fully quit ${browser} and re-run, or use mode 'sandbox-persistent'.`;

export const launchExisting = async (
  input: LaunchExistingInput,
  deps: LaunchDeps,
): Promise<LaunchResult> => {
  const portLive = await deps.probeDebugPort(input.port);
  const processRunning = portLive
    ? true
    : await deps.isProcessRunning(input.browser, input.execPath);
  const action = chooseLaunchAction(classifyRunState(portLive, processRunning));

  const base = {
    ok: true as const,
    browser: input.browser,
    profileType: 'existing' as const,
    action,
  };

  if (action === 'attach') {
    return Object.freeze({
      ...base,
      browserUrl: browserUrlFor(input.port),
      attached: true,
      pid: null,
    });
  }

  if (action === 'new-window') {
    const { cmd, args } = buildNewWindowArgs(input.execPath);
    const { pid } = await deps.spawnBrowser(cmd, args);
    return Object.freeze({
      ...base,
      browserUrl: null,
      attached: false,
      pid,
      degradation: degradationMessage(input.browser),
    });
  }

  // spawn-fresh
  const { cmd, args } = buildFreshSpawnArgs(
    input.execPath,
    input.port,
    input.userDataDir,
  );
  const { pid } = await deps.spawnBrowser(cmd, args);
  return Object.freeze({
    ...base,
    browserUrl: browserUrlFor(input.port),
    attached: true,
    pid,
  });
};
