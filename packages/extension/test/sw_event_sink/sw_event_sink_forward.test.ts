import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEventSink } from '../../src/sw_event_sink/sw_event_sink.js';
import type {
  CapturedEvent,
  ConsoleCapturedEvent,
} from '../../src/captures/types.js';

const makeConsoleEvent = (ts: number = 1): ConsoleCapturedEvent => ({
  kind: 'console',
  level: 'log',
  args: ['msg'],
  ts,
  frameUrl: 'https://x',
  frameKey: 'top',
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createEventSink — forwardEvents absent', () => {
  it('does not forward; existing local-buffer behavior unchanged', () => {
    const sink = createEventSink({});
    sink.handle(makeConsoleEvent(1));
    sink.handle(makeConsoleEvent(2));
    expect(sink.getStats().totalReceived).toBe(2);
  });

  it('flushNow + dispose are no-ops (do not throw)', () => {
    const sink = createEventSink({});
    expect(() => sink.flushNow()).not.toThrow();
    expect(() => sink.dispose()).not.toThrow();
  });
});

describe('createEventSink — forwardEvents present', () => {
  it('flushes a batch when forwardMaxSize is reached', () => {
    const flush = vi.fn<(events: readonly CapturedEvent[]) => void>();
    const sink = createEventSink({
      forwardEvents: flush,
      forwardMaxSize: 3,
      forwardMaxMs: 100,
    });
    sink.handle(makeConsoleEvent(1));
    sink.handle(makeConsoleEvent(2));
    expect(flush).not.toHaveBeenCalled();
    sink.handle(makeConsoleEvent(3));
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]![0].map((e) => e.ts)).toEqual([1, 2, 3]);
  });

  it('flushes a batch when forwardMaxMs elapses below size threshold', () => {
    const flush = vi.fn<(events: readonly CapturedEvent[]) => void>();
    const sink = createEventSink({
      forwardEvents: flush,
      forwardMaxSize: 50,
      forwardMaxMs: 100,
    });
    sink.handle(makeConsoleEvent(1));
    sink.handle(makeConsoleEvent(2));
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]![0]).toHaveLength(2);
  });

  it('sink.flushNow drains in-flight batch on demand', () => {
    const flush = vi.fn<(events: readonly CapturedEvent[]) => void>();
    const sink = createEventSink({
      forwardEvents: flush,
      forwardMaxSize: 50,
      forwardMaxMs: 100,
    });
    sink.handle(makeConsoleEvent(1));
    sink.flushNow();
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]![0].map((e) => e.ts)).toEqual([1]);
  });

  it('sink.dispose stops the timer without flushing', () => {
    const flush = vi.fn<(events: readonly CapturedEvent[]) => void>();
    const sink = createEventSink({
      forwardEvents: flush,
      forwardMaxSize: 50,
      forwardMaxMs: 100,
    });
    sink.handle(makeConsoleEvent(1));
    sink.dispose();
    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();
  });

  it('local buffer + getRecent still work alongside forwarding', () => {
    const flush = vi.fn<(events: readonly CapturedEvent[]) => void>();
    const sink = createEventSink({
      forwardEvents: flush,
      forwardMaxSize: 50,
      forwardMaxMs: 100,
    });
    sink.handle(makeConsoleEvent(1));
    sink.handle(makeConsoleEvent(2));
    const recent = sink.getRecent();
    expect(recent.events).toHaveLength(2);
    expect(recent.events.map((e) => e.ts)).toEqual([1, 2]);
  });

  it('logger callback fires alongside forward — both observe each event', () => {
    const flush = vi.fn<(events: readonly CapturedEvent[]) => void>();
    const logged: CapturedEvent[] = [];
    const sink = createEventSink({
      forwardEvents: flush,
      forwardMaxSize: 50,
      forwardMaxMs: 100,
      logger: (e) => {
        logged.push(e);
      },
    });
    sink.handle(makeConsoleEvent(1));
    sink.handle(makeConsoleEvent(2));
    expect(logged).toHaveLength(2);
    sink.flushNow();
    expect(flush.mock.calls[0]![0]).toHaveLength(2);
  });

  it('default forwardMaxSize=50 + forwardMaxMs=100 when not specified', () => {
    const flush = vi.fn<(events: readonly CapturedEvent[]) => void>();
    const sink = createEventSink({ forwardEvents: flush });
    for (let i = 0; i < 49; i++) sink.handle(makeConsoleEvent(i));
    expect(flush).not.toHaveBeenCalled();
    sink.handle(makeConsoleEvent(49));
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]![0]).toHaveLength(50);
  });
});
