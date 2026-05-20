import { describe, it, expect, beforeEach } from 'vitest';
import {
  installRrwebRecording,
  type RrwebRecorder,
  type RrwebEvent,
} from '../../src/rrweb_record/record.js';
import type {
  CapturedEvent,
  ReplayCapturedEvent,
} from '@pwa-debug/shared';
import type { FrameMeta } from '../../src/captures/capture_console.js';

const FRAME: FrameMeta = {
  ts: 1000,
  frameUrl: 'https://test.local/',
  frameKey: 'top',
};

const makeFakeRecorder = (): {
  recorder: RrwebRecorder;
  fire: (e: RrwebEvent) => void;
  stop: { called: boolean };
} => {
  let captured: ((e: RrwebEvent) => void) | null = null;
  const stop = { called: false };
  const recorder: RrwebRecorder = (options) => {
    captured = options.emit;
    return () => {
      stop.called = true;
    };
  };
  return {
    recorder,
    fire: (e) => {
      if (captured !== null) captured(e);
    },
    stop,
  };
};

describe('installRrwebRecording', () => {
  let emits: ReplayCapturedEvent[];

  beforeEach(() => {
    emits = [];
  });

  const capture = (e: CapturedEvent): void => {
    if (e.kind === 'replay') emits.push(e);
  };

  it('forwards each rrweb event as a ReplayCapturedEvent', () => {
    const fake = makeFakeRecorder();
    installRrwebRecording({
      emit: capture,
      frame: FRAME,
      sessionId: 'sess-1',
      recorder: fake.recorder,
    });
    fake.fire({ type: 2, data: { node: { id: 1 } }, timestamp: 5000 });
    fake.fire({ type: 3, data: { source: 0 }, timestamp: 5100 });
    expect(emits).toHaveLength(2);
    expect(emits[0]).toMatchObject({
      kind: 'replay',
      sessionId: 'sess-1',
      rrwebType: 2,
      data: { node: { id: 1 } },
      timestamp: 5000,
      frameUrl: FRAME.frameUrl,
      frameKey: FRAME.frameKey,
    });
    expect(emits[1]?.rrwebType).toBe(3);
  });

  it('disposer calls the rrweb stop function', () => {
    const fake = makeFakeRecorder();
    const dispose = installRrwebRecording({
      emit: capture,
      frame: FRAME,
      sessionId: 'sess-2',
      recorder: fake.recorder,
    });
    expect(fake.stop.called).toBe(false);
    dispose();
    expect(fake.stop.called).toBe(true);
  });

  it('disposer is idempotent (second call is a no-op)', () => {
    const fake = makeFakeRecorder();
    let stopCalls = 0;
    const recorder: RrwebRecorder = (options) => {
      void options;
      return () => {
        stopCalls++;
      };
    };
    const dispose = installRrwebRecording({
      emit: capture,
      frame: FRAME,
      sessionId: 's',
      recorder,
    });
    dispose();
    dispose();
    expect(stopCalls).toBe(1);
  });

  it('schedules an auto-stop when durationCapMs is set', () => {
    const fake = makeFakeRecorder();
    let scheduledMs: number | null = null;
    let scheduledCb: (() => void) | null = null;
    const setTimer = (cb: () => void, ms: number): number => {
      scheduledCb = cb;
      scheduledMs = ms;
      return 42;
    };
    let clearedId: number | null = null;
    const clearTimer = (id: number): void => {
      clearedId = id;
    };
    installRrwebRecording({
      emit: capture,
      frame: FRAME,
      sessionId: 'sess-cap',
      durationCapMs: 5000,
      recorder: fake.recorder,
      setTimer,
      clearTimer,
    });
    expect(scheduledMs).toBe(5000);
    expect(fake.stop.called).toBe(false);
    // Fire the timer callback → recording stops.
    if (scheduledCb !== null) (scheduledCb as () => void)();
    expect(fake.stop.called).toBe(true);
    // No timer-clear needed when timer fires itself.
    expect(clearedId).toBeNull();
  });

  it('clearing the timer happens when disposed before the cap fires', () => {
    const fake = makeFakeRecorder();
    let clearedId: number | null = null;
    const setTimer = (_cb: () => void, _ms: number): number => 99;
    const clearTimer = (id: number): void => {
      clearedId = id;
    };
    const dispose = installRrwebRecording({
      emit: capture,
      frame: FRAME,
      sessionId: 'sess-clear',
      durationCapMs: 5000,
      recorder: fake.recorder,
      setTimer,
      clearTimer,
    });
    dispose();
    expect(clearedId).toBe(99);
    expect(fake.stop.called).toBe(true);
  });

  it('no timer is scheduled when durationCapMs is omitted or zero', () => {
    const fake = makeFakeRecorder();
    let calls = 0;
    const setTimer = (): number => {
      calls++;
      return 0;
    };
    installRrwebRecording({
      emit: capture,
      frame: FRAME,
      sessionId: 'no-cap',
      recorder: fake.recorder,
      setTimer,
    });
    installRrwebRecording({
      emit: capture,
      frame: FRAME,
      sessionId: 'zero-cap',
      durationCapMs: 0,
      recorder: fake.recorder,
      setTimer,
    });
    expect(calls).toBe(0);
  });
});
