/**
 * Page-world rrweb recording manager. Wraps rrweb's record({ emit }) API and
 * converts each emitted rrweb event into a ReplayCapturedEvent that flows
 * through the existing capture pipeline (emit → CS → SW → host buffer).
 *
 * The recorder is injectable via opts.recorder so tests can drive the manager
 * with a fake API surface. The default uses rrweb's real record export.
 *
 * Pure-FP outside the install side effect: install() returns a Disposer that
 * tears down the rrweb subscription + cancels any duration-cap timer.
 */
import type { FrameMeta } from '../captures/capture_console.js';
import type { ReplayCapturedEvent } from '@pwa-debug/shared';
import * as rrweb from 'rrweb';

/** The shape we use from rrweb's event payload. Kept narrow on purpose so the
 *  manager stays independent of rrweb's internal type churn. */
export type RrwebEvent = {
  readonly type: number;
  readonly data: unknown;
  readonly timestamp: number;
};

export type RrwebRecorder = (options: {
  emit: (event: RrwebEvent) => void;
}) => (() => void) | undefined;

export type StoreSubscriptionDisposer = () => void;

export type InstallRecordingOptions = {
  readonly emit: (event: ReplayCapturedEvent) => void;
  readonly frame: FrameMeta;
  readonly sessionId: string;
  readonly durationCapMs?: number;
  /** Injected for tests; defaults to rrweb's record(). */
  readonly recorder?: RrwebRecorder;
  /** Injected for tests; defaults to setTimeout. */
  readonly setTimer?: (cb: () => void, ms: number) => number;
  /** Injected for tests; defaults to clearTimeout. */
  readonly clearTimer?: (id: number) => void;
};

const defaultRecorder: RrwebRecorder = (options) => {
  // rrweb is bundled into page-world.js by rollup. ~100KB minified — future
  // M12.5 may split it behind a web_accessible_resources lazy load.
  return (
    rrweb as unknown as {
      record: (opts: { emit: (e: unknown) => void }) => (() => void) | undefined;
    }
  ).record({
    emit: (e: unknown) => {
      // Narrow rrweb's event to our internal RrwebEvent shape (just the three
      // fields we propagate); rrweb's type churns across versions.
      const ev = e as { type: number; data: unknown; timestamp: number };
      options.emit({
        type: ev.type,
        data: ev.data,
        timestamp: ev.timestamp,
      });
    },
  });
};

export const installRrwebRecording = (
  opts: InstallRecordingOptions,
): StoreSubscriptionDisposer => {
  const recorder = opts.recorder ?? defaultRecorder;
  const setTimer = opts.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id) => globalThis.clearTimeout(id));

  const stop = recorder({
    emit: (rrwebEvent) => {
      const event: ReplayCapturedEvent = {
        kind: 'replay',
        ts: rrwebEvent.timestamp,
        frameUrl: opts.frame.frameUrl,
        frameKey: opts.frame.frameKey,
        sessionId: opts.sessionId,
        rrwebType: rrwebEvent.type,
        data: rrwebEvent.data,
        timestamp: rrwebEvent.timestamp,
      };
      opts.emit(event);
    },
  });

  let timerId: number | null = null;
  let disposed = false;

  const dispose: StoreSubscriptionDisposer = () => {
    if (disposed) return;
    disposed = true;
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
    if (typeof stop === 'function') stop();
  };

  if (opts.durationCapMs !== undefined && opts.durationCapMs > 0) {
    timerId = setTimer(() => {
      // Timer already fired — null out the id BEFORE dispose so dispose
      // doesn't redundantly call clearTimer on a spent handle.
      timerId = null;
      dispose();
    }, opts.durationCapMs);
  }

  return dispose;
};
