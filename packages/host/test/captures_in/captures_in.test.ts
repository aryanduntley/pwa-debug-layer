import { describe, it, expect } from 'vitest';
import {
  createCapturesIn,
  type HostCapturedEvent,
  type CapturesIn,
} from '../../src/captures_in/captures_in.js';

const FIXED_NOW = 1_000_000_000;
const FIXED_SESSION = 'sess-test';
const EXT_ID = 'ext-abc';

const make = (overrides: Partial<Parameters<typeof createCapturesIn>[0]> = {}): CapturesIn =>
  createCapturesIn({
    extensionId: EXT_ID,
    capacityPerKind: 5,
    getNow: () => FIXED_NOW,
    sessionId: FIXED_SESSION,
    ...overrides,
  });

const event = (kind: string, ts: number, extra: Record<string, unknown> = {}): HostCapturedEvent =>
  ({ kind, ts, ...extra }) as HostCapturedEvent;

describe('createCapturesIn — per-kind routing', () => {
  it('routes console events to console bucket only', () => {
    const ci = make();
    ci.receive({ events: [event('console', 1, { level: 'log', args: ['hi'] })] });
    expect(ci.tail('console')).toHaveLength(1);
    expect(ci.tail('network')).toHaveLength(0);
    expect(ci.tail('dom_mutations')).toHaveLength(0);
    expect(ci.tail('lifecycle')).toHaveLength(0);
  });

  it('coalesces fetch + xhr + websocket into network bucket in arrival order', () => {
    const ci = make();
    ci.receive({
      events: [
        event('fetch', 1, { phase: 'request' }),
        event('xhr', 2, { phase: 'response' }),
        event('websocket', 3, { subkind: 'open' }),
      ],
    });
    const network = ci.tail('network');
    expect(network).toHaveLength(3);
    expect(network.map((e) => e.kind)).toEqual(['fetch', 'xhr', 'websocket']);
  });

  it('routes dom_mutation and lifecycle to their own buckets', () => {
    const ci = make();
    ci.receive({
      events: [
        event('dom_mutation', 1, { patches: [] }),
        event('lifecycle', 2, { source: 'page', subkind: 'pagehide' }),
      ],
    });
    expect(ci.tail('dom_mutations')).toHaveLength(1);
    expect(ci.tail('lifecycle')).toHaveLength(1);
    expect(ci.tail('console')).toHaveLength(0);
    expect(ci.tail('network')).toHaveLength(0);
  });
});

describe('createCapturesIn — metadata attachment', () => {
  it('attaches receivedAt from injected getNow, sessionId, extensionId', () => {
    const ci = make();
    ci.receive({ events: [event('console', 42)] });
    const [stored] = ci.tail('console');
    expect(stored).toBeDefined();
    expect(stored.ts).toBe(42); // original page-world clock preserved
    expect(stored.receivedAt).toBe(FIXED_NOW);
    expect(stored.sessionId).toBe(FIXED_SESSION);
    expect(stored.extensionId).toBe(EXT_ID);
  });

  it('preserves opaque payload fields verbatim', () => {
    const ci = make();
    ci.receive({
      events: [
        event('fetch', 1, {
          phase: 'response',
          captureId: 'abc',
          status: 200,
          body: { foo: 'bar' },
        }),
      ],
    });
    const [stored] = ci.tail('network');
    expect(stored).toMatchObject({
      kind: 'fetch',
      phase: 'response',
      captureId: 'abc',
      status: 200,
      body: { foo: 'bar' },
    });
  });

  it('sessionId is stable across multiple receive() calls', () => {
    const ci = make();
    ci.receive({ events: [event('console', 1)] });
    ci.receive({ events: [event('console', 2)] });
    const stats = ci.getStats();
    const stored = ci.tail('console');
    expect(stats.sessionId).toBe(FIXED_SESSION);
    expect(stored.every((e) => e.sessionId === FIXED_SESSION)).toBe(true);
  });

  it('generates a session id when none injected', () => {
    const a = createCapturesIn({ extensionId: EXT_ID });
    const b = createCapturesIn({ extensionId: EXT_ID });
    expect(a.getStats().sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.getStats().sessionId).not.toBe(b.getStats().sessionId);
  });
});

describe('createCapturesIn — drop accounting', () => {
  it('drops null / non-object events as droppedUnknown without throwing', () => {
    const ci = make();
    expect(() =>
      ci.receive({
        events: [null as unknown as HostCapturedEvent, 'string' as unknown as HostCapturedEvent, 42 as unknown as HostCapturedEvent],
      }),
    ).not.toThrow();
    const stats = ci.getStats();
    expect(stats.droppedUnknown).toBe(3);
    expect(stats.totals.received).toBe(0);
    expect(stats.totals.dropped).toBe(3);
  });

  it('drops events with missing or non-string kind as droppedUnknown', () => {
    const ci = make();
    ci.receive({
      events: [
        { ts: 1 } as unknown as HostCapturedEvent,
        { ts: 2, kind: 99 } as unknown as HostCapturedEvent,
      ],
    });
    expect(ci.getStats().droppedUnknown).toBe(2);
  });

  it('drops events with unknown kind as droppedUnknown', () => {
    const ci = make();
    ci.receive({ events: [event('garbage', 1), event('framework_state', 2)] });
    expect(ci.getStats().droppedUnknown).toBe(2);
  });

  it('drops recognized-kind events with bad ts as per-kind dropped', () => {
    const ci = make();
    ci.receive({
      events: [
        { kind: 'console' } as unknown as HostCapturedEvent,
        event('fetch', NaN),
        event('xhr', Infinity),
        { kind: 'lifecycle', ts: 'oops' } as unknown as HostCapturedEvent,
      ],
    });
    const stats = ci.getStats();
    expect(stats.perKind.console.dropped).toBe(1);
    expect(stats.perKind.network.dropped).toBe(2);
    expect(stats.perKind.lifecycle.dropped).toBe(1);
    expect(stats.droppedUnknown).toBe(0);
    expect(stats.totals.dropped).toBe(4);
  });
});

describe('createCapturesIn — capacity isolation + getStats', () => {
  it('overflow on one kind does not affect other buckets', () => {
    const ci = make({ capacityPerKind: 2 });
    for (let i = 0; i < 5; i++) ci.receive({ events: [event('console', i)] });
    ci.receive({
      events: [event('fetch', 100), event('lifecycle', 200, { source: 'page', subkind: 'pageshow' })],
    });
    expect(ci.tail('console')).toHaveLength(2);
    expect(ci.tail('console').map((e) => e.ts)).toEqual([3, 4]); // FIFO
    expect(ci.tail('network')).toHaveLength(1);
    expect(ci.tail('lifecycle')).toHaveLength(1);
  });

  it('getStats shape', () => {
    const ci = make();
    ci.receive({
      events: [event('console', 1), event('fetch', 2), event('garbage', 3)],
    });
    const stats = ci.getStats();
    expect(stats).toMatchObject({
      perKind: {
        console: { received: 1, dropped: 0, size: 1 },
        network: { received: 1, dropped: 0, size: 1 },
        dom_mutations: { received: 0, dropped: 0, size: 0 },
        lifecycle: { received: 0, dropped: 0, size: 0 },
      },
      droppedUnknown: 1,
      totals: { received: 2, dropped: 1 },
      sessionId: FIXED_SESSION,
      extensionId: EXT_ID,
    });
  });
});

describe('createCapturesIn — tail forwarding + clear', () => {
  it('forwards RingBufferTailOptions (since/limit/filter) to underlying buffer', () => {
    const ci = make();
    ci.receive({
      events: [
        event('console', 1, { level: 'log' }),
        event('console', 2, { level: 'warn' }),
        event('console', 3, { level: 'log' }),
        event('console', 4, { level: 'error' }),
      ],
    });
    expect(ci.tail('console', { since: 2 }).map((e) => e.ts)).toEqual([3, 4]);
    expect(ci.tail('console', { limit: 2 }).map((e) => e.ts)).toEqual([3, 4]);
    expect(
      ci
        .tail('console', { filter: (e) => e.level === 'log' })
        .map((e) => e.ts),
    ).toEqual([1, 3]);
  });

  it('clear() resets all buffers and counters', () => {
    const ci = make();
    ci.receive({
      events: [event('console', 1), event('fetch', 2), event('garbage', 3)],
    });
    ci.clear();
    const stats = ci.getStats();
    for (const k of ['console', 'network', 'dom_mutations', 'lifecycle'] as const) {
      expect(stats.perKind[k]).toEqual({ received: 0, dropped: 0, size: 0 });
      expect(ci.tail(k)).toEqual([]);
    }
    expect(stats.droppedUnknown).toBe(0);
    expect(stats.totals).toEqual({ received: 0, dropped: 0 });
  });
});

describe('createCapturesIn — per-bucket sequenceNumber stamping', () => {
  it('first event in each bucket gets sequenceNumber=1', () => {
    const ci = make();
    ci.receive({
      events: [
        event('console', 1, { level: 'log' }),
        event('fetch', 2, { phase: 'request' }),
        event('dom_mutation', 3, { patches: [] }),
        event('lifecycle', 4, { source: 'page', subkind: 'pageshow' }),
      ],
    });
    expect(ci.tail('console')[0]?.sequenceNumber).toBe(1);
    expect(ci.tail('network')[0]?.sequenceNumber).toBe(1);
    expect(ci.tail('dom_mutations')[0]?.sequenceNumber).toBe(1);
    expect(ci.tail('lifecycle')[0]?.sequenceNumber).toBe(1);
  });

  it('sequenceNumber is monotonic within a bucket and independent across buckets', () => {
    const ci = make();
    ci.receive({
      events: [
        event('console', 1, { level: 'log' }),
        event('fetch', 2, { phase: 'request' }),
        event('console', 3, { level: 'warn' }),
        event('xhr', 4, { phase: 'request' }),
        event('console', 5, { level: 'error' }),
      ],
    });
    expect(ci.tail('console').map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    expect(ci.tail('network').map((e) => e.sequenceNumber)).toEqual([1, 2]);
  });

  it('dropped events do not advance the sequence counter', () => {
    const ci = make();
    ci.receive({
      events: [
        event('console', 1, { level: 'log' }),
        { kind: 'console' } as unknown as HostCapturedEvent, // dropped: bad ts
        event('console', 2, { level: 'warn' }),
      ],
    });
    expect(ci.tail('console').map((e) => e.sequenceNumber)).toEqual([1, 2]);
  });

  it('clear() resets sequenceNumber so the next push starts at 1 again', () => {
    const ci = make();
    ci.receive({
      events: [
        event('console', 1, { level: 'log' }),
        event('console', 2, { level: 'warn' }),
        event('console', 3, { level: 'error' }),
      ],
    });
    expect(ci.tail('console').map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    ci.clear();
    ci.receive({ events: [event('console', 10, { level: 'log' })] });
    expect(ci.tail('console')[0]?.sequenceNumber).toBe(1);
  });
});
