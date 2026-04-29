import { describe, it, expect, vi } from 'vitest';
import {
  createEventSink,
  isPageEventSwMessage,
} from '../../src/sw_event_sink/sw_event_sink.js';
import { PAGE_EVENT_SW_TAG } from '../../src/page_bridge/cs_dispatcher.js';
import type { ConsoleCapturedEvent } from '../../src/captures/types.js';

const makeConsoleEvent = (
  level: ConsoleCapturedEvent['level'] = 'log',
): ConsoleCapturedEvent => ({
  kind: 'console',
  level,
  args: ['test'],
  ts: 1,
  frameUrl: 'https://x',
  frameKey: 'top',
});

describe('createEventSink', () => {
  it('handle increments perKind counters and total', () => {
    const sink = createEventSink();
    sink.handle(makeConsoleEvent());
    sink.handle(makeConsoleEvent('warn'));
    sink.handle(makeConsoleEvent());
    const stats = sink.getStats();
    expect(stats.totalReceived).toBe(3);
    expect(stats.perKind['console']).toBe(3);
  });

  it('getStats returns a frozen snapshot decoupled from later mutations', () => {
    const sink = createEventSink();
    sink.handle(makeConsoleEvent());
    const snapshot = sink.getStats();
    sink.handle(makeConsoleEvent());
    expect(snapshot.totalReceived).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.perKind)).toBe(true);
  });

  it('invokes the injected logger for every event', () => {
    const logger = vi.fn();
    const sink = createEventSink({ logger });
    sink.handle(makeConsoleEvent());
    sink.handle(makeConsoleEvent('error'));
    expect(logger).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'console', level: 'error' }),
    );
  });

  it("logger failures don't interrupt event ingestion", () => {
    const logger = vi.fn(() => {
      throw new Error('logger crashed');
    });
    const sink = createEventSink({ logger });
    expect(() => sink.handle(makeConsoleEvent())).not.toThrow();
    expect(sink.getStats().totalReceived).toBe(1);
  });
});

describe('isPageEventSwMessage', () => {
  it('accepts well-formed page-event SW messages', () => {
    expect(
      isPageEventSwMessage({ tag: PAGE_EVENT_SW_TAG, event: { kind: 'console' } }),
    ).toBe(true);
  });

  it('rejects wrong tag', () => {
    expect(isPageEventSwMessage({ tag: 'something-else', event: {} })).toBe(false);
  });

  it('rejects missing event field', () => {
    expect(isPageEventSwMessage({ tag: PAGE_EVENT_SW_TAG })).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(isPageEventSwMessage(null)).toBe(false);
    expect(isPageEventSwMessage('string')).toBe(false);
    expect(isPageEventSwMessage(42)).toBe(false);
  });
});
