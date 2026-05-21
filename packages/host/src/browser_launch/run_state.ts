/**
 * The triad: pure mapping from observed browser state to a launch action.
 * This is the single source of the (a)/(b)/(c) decision; everything else
 * (probing, spawning) is plumbing around these two functions.
 */
import type { BrowserRunState, LaunchAction } from './types.js';

/** Classify the browser's runtime state. A live port implies it is running. */
export const classifyRunState = (
  portLive: boolean,
  processRunning: boolean,
): BrowserRunState =>
  portLive ? 'port-live' : processRunning ? 'running-no-port' : 'not-running';

/** Choose the launch action for a run state. */
export const chooseLaunchAction = (state: BrowserRunState): LaunchAction =>
  state === 'port-live'
    ? 'attach'
    : state === 'running-no-port'
      ? 'new-window'
      : 'spawn-fresh';
