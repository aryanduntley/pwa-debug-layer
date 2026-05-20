/**
 * Module-singleton holding the active rrweb recording. One recording per
 * page-world. start() tears down any prior recording before installing a fresh
 * one (idempotent re-config). stop() tears down and clears.
 *
 * resetRecordingState() is test-only; production code never calls it.
 */
import {
  installRrwebRecording,
  type InstallRecordingOptions,
  type StoreSubscriptionDisposer,
} from './record.js';

type ActiveRecording = {
  readonly sessionId: string;
  readonly durationCapMs?: number;
  readonly dispose: StoreSubscriptionDisposer;
};

let active: ActiveRecording | null = null;

export const startRecording = (opts: InstallRecordingOptions): string => {
  if (active !== null) {
    active.dispose();
    active = null;
  }
  const dispose = installRrwebRecording(opts);
  active = {
    sessionId: opts.sessionId,
    ...(opts.durationCapMs !== undefined
      ? { durationCapMs: opts.durationCapMs }
      : {}),
    dispose,
  };
  return opts.sessionId;
};

export const stopRecording = (): string | null => {
  if (active === null) return null;
  const sessionId = active.sessionId;
  active.dispose();
  active = null;
  return sessionId;
};

export const getActiveSessionId = (): string | null =>
  active === null ? null : active.sessionId;

export const getActiveDurationCapMs = (): number | undefined =>
  active === null ? undefined : active.durationCapMs;

/** Test-only: drop the singleton state without invoking disposers (used for
 *  test isolation when the dispose itself was mocked). */
export const resetRecordingState = (): void => {
  active = null;
};
