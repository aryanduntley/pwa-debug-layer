import { describe, it, expect, beforeEach } from 'vitest';
import {
  startRecording,
  stopRecording,
  getActiveSessionId,
  getActiveDurationCapMs,
  resetRecordingState,
} from '../../src/rrweb_record/state.js';
import type { RrwebRecorder } from '../../src/rrweb_record/record.js';
import type { CapturedEvent } from '@pwa-debug/shared';
import type { FrameMeta } from '../../src/captures/capture_console.js';

const FRAME: FrameMeta = {
  ts: 0,
  frameUrl: 'https://test.local/',
  frameKey: 'top',
};

const noop = (_e: CapturedEvent): void => undefined;

const fakeRecorder =
  (stopCounter: { count: number }): RrwebRecorder =>
  () => () => {
    stopCounter.count++;
  };

const TIMER = (cb: () => void, _ms: number): number => {
  void cb;
  return 1;
};
const NOOP_CLEAR = (_id: number): void => undefined;

describe('rrweb_record state singleton', () => {
  beforeEach(() => {
    resetRecordingState();
  });

  it('starts with no active session', () => {
    expect(getActiveSessionId()).toBeNull();
    expect(getActiveDurationCapMs()).toBeUndefined();
  });

  it('startRecording sets the active session id', () => {
    const stopCounter = { count: 0 };
    startRecording({
      emit: noop,
      frame: FRAME,
      sessionId: 'sess-A',
      recorder: fakeRecorder(stopCounter),
    });
    expect(getActiveSessionId()).toBe('sess-A');
  });

  it('startRecording again tears down the prior recording', () => {
    const stopCounter = { count: 0 };
    startRecording({
      emit: noop,
      frame: FRAME,
      sessionId: 'sess-A',
      recorder: fakeRecorder(stopCounter),
    });
    startRecording({
      emit: noop,
      frame: FRAME,
      sessionId: 'sess-B',
      recorder: fakeRecorder(stopCounter),
    });
    expect(getActiveSessionId()).toBe('sess-B');
    expect(stopCounter.count).toBe(1);
  });

  it('stopRecording clears state and returns the prior session id', () => {
    const stopCounter = { count: 0 };
    startRecording({
      emit: noop,
      frame: FRAME,
      sessionId: 'sess-A',
      recorder: fakeRecorder(stopCounter),
    });
    const prior = stopRecording();
    expect(prior).toBe('sess-A');
    expect(getActiveSessionId()).toBeNull();
    expect(stopCounter.count).toBe(1);
  });

  it('stopRecording on no-active returns null', () => {
    expect(stopRecording()).toBeNull();
  });

  it('preserves durationCapMs', () => {
    const stopCounter = { count: 0 };
    startRecording({
      emit: noop,
      frame: FRAME,
      sessionId: 'sess-cap',
      durationCapMs: 2500,
      recorder: fakeRecorder(stopCounter),
      setTimer: TIMER,
      clearTimer: NOOP_CLEAR,
    });
    expect(getActiveDurationCapMs()).toBe(2500);
  });
});
