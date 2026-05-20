import { describe, it, expect, vi } from 'vitest';
import {
  createEventSink,
  isPageEventSwMessage,
} from '../../src/sw_event_sink/sw_event_sink.js';
import { PAGE_EVENT_SW_TAG } from '../../src/page_bridge/cs_dispatcher.js';
import type {
  CapturedEvent,
  ConsoleCapturedEvent,
} from '../../src/captures/types.js';

const makeConsoleEvent = (
  level: ConsoleCapturedEvent['level'] = 'log',
  ts: number = 1,
): ConsoleCapturedEvent => ({
  kind: 'console',
  level,
  args: ['test'],
  ts,
  frameUrl: 'https://x',
  frameKey: 'top',
});

const makeForeignEvent = (
  kind: string,
  ts: number,
): CapturedEvent =>
  ({
    kind,
    ts,
    frameUrl: 'https://x',
    frameKey: 'top',
  }) as unknown as CapturedEvent;

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

  it('getStats reports bufferSize', () => {
    expect(createEventSink().getStats().bufferSize).toBe(200);
    expect(createEventSink({ bufferSize: 7 }).getStats().bufferSize).toBe(7);
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

describe('createEventSink ring buffer', () => {
  it('falls back to default bufferSize for non-positive or NaN values', () => {
    expect(createEventSink({ bufferSize: 0 }).getStats().bufferSize).toBe(200);
    expect(createEventSink({ bufferSize: -3 }).getStats().bufferSize).toBe(200);
    expect(createEventSink({ bufferSize: NaN }).getStats().bufferSize).toBe(200);
  });

  it('getRecent on empty sink returns events:[]', () => {
    const result = createEventSink().getRecent();
    expect(result.events).toEqual([]);
    expect(result.stats.totalReceived).toBe(0);
  });

  it('getRecent returns events oldest -> newest', () => {
    const sink = createEventSink({ bufferSize: 5 });
    sink.handle(makeConsoleEvent('log', 1));
    sink.handle(makeConsoleEvent('log', 2));
    sink.handle(makeConsoleEvent('log', 3));
    expect(sink.getRecent().events.map((e) => e.ts)).toEqual([1, 2, 3]);
  });

  it('drops oldest events on overflow but totalReceived keeps climbing', () => {
    const sink = createEventSink({ bufferSize: 3 });
    [1, 2, 3, 4, 5].forEach((ts) =>
      sink.handle(makeConsoleEvent('log', ts)),
    );
    const result = sink.getRecent();
    expect(result.events.map((e) => e.ts)).toEqual([3, 4, 5]);
    expect(result.stats.totalReceived).toBe(5);
  });

  it('filters by kinds (kind-agnostic)', () => {
    const sink = createEventSink({ bufferSize: 5 });
    sink.handle(makeConsoleEvent('log', 1));
    sink.handle(makeForeignEvent('fetch', 2));
    sink.handle(makeConsoleEvent('log', 3));
    expect(
      sink.getRecent({ kinds: ['console'] }).events.map((e) => e.ts),
    ).toEqual([1, 3]);
    expect(
      sink.getRecent({ kinds: ['fetch'] }).events.map((e) => e.ts),
    ).toEqual([2]);
    expect(
      sink.getRecent({ kinds: ['console', 'fetch'] }).events.map((e) => e.ts),
    ).toEqual([1, 2, 3]);
  });

  it('filters by sinceMs (strict greater-than)', () => {
    const sink = createEventSink({ bufferSize: 5 });
    [1, 2, 3, 4].forEach((ts) =>
      sink.handle(makeConsoleEvent('log', ts)),
    );
    expect(sink.getRecent({ sinceMs: 2 }).events.map((e) => e.ts)).toEqual([
      3, 4,
    ]);
    expect(sink.getRecent({ sinceMs: 0 }).events.map((e) => e.ts)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(sink.getRecent({ sinceMs: 4 }).events).toEqual([]);
  });

  it('caps results to limit (most-recent-N)', () => {
    const sink = createEventSink({ bufferSize: 10 });
    for (let i = 1; i <= 8; i++) sink.handle(makeConsoleEvent('log', i));
    expect(sink.getRecent({ limit: 3 }).events.map((e) => e.ts)).toEqual([
      6, 7, 8,
    ]);
  });

  it('default limit is 50', () => {
    const sink = createEventSink({ bufferSize: 100 });
    for (let i = 1; i <= 60; i++) sink.handle(makeConsoleEvent('log', i));
    const events = sink.getRecent().events;
    expect(events.length).toBe(50);
    expect(events[0]?.ts).toBe(11);
    expect(events[events.length - 1]?.ts).toBe(60);
  });

  it('limit clamps to bufferSize', () => {
    const sink = createEventSink({ bufferSize: 5 });
    for (let i = 1; i <= 5; i++) sink.handle(makeConsoleEvent('log', i));
    expect(sink.getRecent({ limit: 1000 }).events.length).toBe(5);
  });

  it('combines kinds + sinceMs + limit', () => {
    const sink = createEventSink({ bufferSize: 10 });
    for (let i = 1; i <= 6; i++) sink.handle(makeConsoleEvent('log', i));
    sink.handle(makeForeignEvent('fetch', 7));
    sink.handle(makeForeignEvent('fetch', 8));
    const result = sink.getRecent({
      kinds: ['console'],
      sinceMs: 2,
      limit: 2,
    });
    expect(result.events.map((e) => e.ts)).toEqual([5, 6]);
  });

  it('getRecent result is frozen and decoupled from later mutations', () => {
    const sink = createEventSink({ bufferSize: 3 });
    sink.handle(makeConsoleEvent('log', 1));
    const snapshot = sink.getRecent();
    sink.handle(makeConsoleEvent('log', 2));
    expect(snapshot.events.length).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.stats)).toBe(true);
  });
});

describe('createEventSink kind-agnostic tally for M9 Task 8 net producers', () => {
  it('accumulates fetch / xhr / websocket independently in perKind', () => {
    const sink = createEventSink();
    sink.handle(makeForeignEvent('fetch', 1));
    sink.handle(makeForeignEvent('fetch', 2));
    sink.handle(makeForeignEvent('xhr', 3));
    sink.handle(makeForeignEvent('websocket', 4));
    sink.handle(makeForeignEvent('websocket', 5));
    sink.handle(makeForeignEvent('websocket', 6));
    sink.handle(makeConsoleEvent('log', 7));

    const stats = sink.getStats();
    expect(stats.totalReceived).toBe(7);
    expect(stats.perKind['console']).toBe(1);
    expect(stats.perKind['fetch']).toBe(2);
    expect(stats.perKind['xhr']).toBe(1);
    expect(stats.perKind['websocket']).toBe(3);
  });

  it("accepts kind:'dom_mutation' from M10 Task 9 — kind-agnostic perKind tally", () => {
    const sink = createEventSink();
    sink.handle(makeForeignEvent('dom_mutation', 1));
    sink.handle(makeForeignEvent('dom_mutation', 2));
    sink.handle(makeForeignEvent('dom_mutation', 3));
    sink.handle(makeForeignEvent('fetch', 4));
    sink.handle(makeConsoleEvent('log', 5));

    const stats = sink.getStats();
    expect(stats.totalReceived).toBe(5);
    expect(stats.perKind['dom_mutation']).toBe(3);
    expect(stats.perKind['fetch']).toBe(1);
    expect(stats.perKind['console']).toBe(1);

    expect(
      sink
        .getRecent({ kinds: ['dom_mutation'] })
        .events.map((e) => e.ts),
    ).toEqual([1, 2, 3]);
  });

  it("accepts kind:'lifecycle' from M10 Task 11 — kind-agnostic perKind tally + getRecent filter", () => {
    const sink = createEventSink();
    sink.handle({
      kind: 'lifecycle',
      source: 'page',
      subkind: 'navigation',
      method: 'pushState',
      url: 'https://x/a',
      ts: 1,
      frameUrl: 'https://x',
      frameKey: 'top',
    } as unknown as CapturedEvent);
    sink.handle({
      kind: 'lifecycle',
      source: 'page',
      subkind: 'pageshow',
      persisted: false,
      ts: 2,
      frameUrl: 'https://x',
      frameKey: 'top',
    } as unknown as CapturedEvent);
    sink.handle(makeForeignEvent('dom_mutation', 3));
    sink.handle(makeConsoleEvent('log', 4));

    const stats = sink.getStats();
    expect(stats.totalReceived).toBe(4);
    expect(stats.perKind['lifecycle']).toBe(2);
    expect(stats.perKind['dom_mutation']).toBe(1);
    expect(stats.perKind['console']).toBe(1);

    const lifecycleOnly = sink.getRecent({ kinds: ['lifecycle'] });
    expect(lifecycleOnly.events.map((e) => e.ts)).toEqual([1, 2]);
    expect(lifecycleOnly.events.every((e) => e.kind === 'lifecycle')).toBe(true);
  });

  it("M10 Task 12: mixed source:'page' + source:'sw' lifecycle events tally under one perKind.lifecycle counter", () => {
    const sink = createEventSink();
    // source:'page' (Task 11)
    sink.handle({
      kind: 'lifecycle',
      source: 'page',
      subkind: 'pageshow',
      persisted: false,
      ts: 1,
      frameUrl: 'https://x',
      frameKey: 'top',
    } as unknown as CapturedEvent);
    sink.handle({
      kind: 'lifecycle',
      source: 'page',
      subkind: 'navigation',
      method: 'pushState',
      url: 'https://x/a',
      ts: 2,
      frameUrl: 'https://x',
      frameKey: 'top',
    } as unknown as CapturedEvent);
    // source:'sw' (Task 12)
    sink.handle({
      kind: 'lifecycle',
      source: 'sw',
      subkind: 'navigation_committed',
      tabId: 5,
      frameId: 0,
      url: 'https://x/a',
      ts: 3,
      frameUrl: 'https://x/a',
      frameKey: 'top',
    } as unknown as CapturedEvent);
    sink.handle({
      kind: 'lifecycle',
      source: 'sw',
      subkind: 'tab_status',
      tabId: 5,
      status: 'complete',
      ts: 4,
      frameUrl: 'https://x',
      frameKey: 'top',
    } as unknown as CapturedEvent);

    // Single perKind counter regardless of source — sink stays kind-agnostic.
    const stats = sink.getStats();
    expect(stats.totalReceived).toBe(4);
    expect(stats.perKind['lifecycle']).toBe(4);

    // getRecent({ kinds:['lifecycle'] }) returns events from BOTH sources.
    const recent = sink.getRecent({ kinds: ['lifecycle'] });
    expect(recent.events.map((e) => e.ts)).toEqual([1, 2, 3, 4]);
    const sources = recent.events.map(
      (e) => (e as { source: string }).source,
    );
    expect(sources).toEqual(['page', 'page', 'sw', 'sw']);
  });

  it('getRecent filters cleanly between net producer kinds (no cross-talk)', () => {
    const sink = createEventSink({ bufferSize: 20 });
    sink.handle(makeForeignEvent('fetch', 1));
    sink.handle(makeForeignEvent('xhr', 2));
    sink.handle(makeForeignEvent('websocket', 3));
    sink.handle(makeForeignEvent('fetch', 4));
    sink.handle(makeForeignEvent('xhr', 5));

    expect(
      sink.getRecent({ kinds: ['fetch'] }).events.map((e) => e.ts),
    ).toEqual([1, 4]);
    expect(
      sink.getRecent({ kinds: ['xhr'] }).events.map((e) => e.ts),
    ).toEqual([2, 5]);
    expect(
      sink.getRecent({ kinds: ['websocket'] }).events.map((e) => e.ts),
    ).toEqual([3]);
    expect(
      sink.getRecent({ kinds: ['fetch', 'websocket'] })
        .events.map((e) => e.ts),
    ).toEqual([1, 3, 4]);
  });

  it('mixed-kind buffer overflow drops oldest regardless of kind', () => {
    const sink = createEventSink({ bufferSize: 4 });
    sink.handle(makeForeignEvent('fetch', 1));
    sink.handle(makeForeignEvent('xhr', 2));
    sink.handle(makeConsoleEvent('log', 3));
    sink.handle(makeForeignEvent('websocket', 4));
    sink.handle(makeForeignEvent('fetch', 5));

    const result = sink.getRecent();
    expect(result.events.map((e) => e.ts)).toEqual([2, 3, 4, 5]);
    expect(result.stats.totalReceived).toBe(5);
    expect(result.stats.perKind['fetch']).toBe(2);
    expect(result.stats.perKind['xhr']).toBe(1);
    expect(result.stats.perKind['console']).toBe(1);
    expect(result.stats.perKind['websocket']).toBe(1);
  });
});

describe('isPageEventSwMessage', () => {
  it('accepts well-formed page-event SW messages', () => {
    expect(
      isPageEventSwMessage({
        tag: PAGE_EVENT_SW_TAG,
        event: { kind: 'console' },
      }),
    ).toBe(true);
  });

  it('rejects wrong tag', () => {
    expect(isPageEventSwMessage({ tag: 'something-else', event: {} })).toBe(
      false,
    );
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

describe('createEventSink shouldRecord gating', () => {
  it('drops gated events from stats, buffer, logger, and forward', () => {
    const logger = vi.fn();
    const forward = vi.fn();
    const sink = createEventSink({
      logger,
      forwardEvents: forward,
      forwardMaxSize: 1, // force immediate flush per accepted event
      shouldRecord: (e) => e.frameUrl === 'https://ok.com/',
    });
    sink.handle({
      ...makeConsoleEvent('log', 1),
      frameUrl: 'https://ok.com/',
    });
    sink.handle({
      ...makeConsoleEvent('log', 2),
      frameUrl: 'https://blocked.com/',
    });
    sink.handle({
      ...makeConsoleEvent('log', 3),
      frameUrl: 'https://blocked.com/',
    });
    const stats = sink.getStats();
    expect(stats.totalReceived).toBe(1);
    expect(stats.perKind['console']).toBe(1);
    expect(sink.getRecent().events.length).toBe(1);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledTimes(1);
    sink.dispose();
  });

  it('is re-evaluated per call (live setting changes propagate immediately)', () => {
    let allow = true;
    const sink = createEventSink({
      shouldRecord: () => allow,
    });
    sink.handle(makeConsoleEvent('log', 1));
    allow = false;
    sink.handle(makeConsoleEvent('log', 2));
    allow = true;
    sink.handle(makeConsoleEvent('log', 3));
    expect(sink.getStats().totalReceived).toBe(2);
    sink.dispose();
  });
});
