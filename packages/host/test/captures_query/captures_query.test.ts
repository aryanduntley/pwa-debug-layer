import { describe, it, expect } from 'vitest';
import { encodeCursor, type Cursor } from '@pwa-debug/shared';
import { createRingBuffer } from '../../src/host_buffers/host_buffers.js';
import type { HostStoredEvent } from '../../src/captures_in/captures_in.js';
import { tailWithFilter } from '../../src/captures_query/captures_query.js';

const SESSION = 'sess-test';
const EXT = 'ext-test';
const ctx = { currentSessionId: SESSION };

const make = (
  overrides: {
    readonly ts: number;
    readonly kind: string;
    readonly sequenceNumber: number;
    readonly [k: string]: unknown;
  },
): HostStoredEvent =>
  ({
    receivedAt: 1000,
    sessionId: SESSION,
    extensionId: EXT,
    ...overrides,
  }) as HostStoredEvent;

const fillSeq = (
  count: number,
  start = 1,
  kind = 'console',
): HostStoredEvent[] => {
  const events: HostStoredEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(make({ kind, ts: start + i, sequenceNumber: start + i }));
  }
  return events;
};

describe('tailWithFilter — empty buffer', () => {
  it('returns empty entries, null cursor, hasMore=false', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(buffer, undefined, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
    expect(result.cursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });
});

describe('tailWithFilter — no-filter latest tail', () => {
  it('returns all events oldest→newest when buffer < limit; cursor = newest', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    for (const e of fillSeq(5)) buffer.push(e);
    const result = tailWithFilter(buffer, undefined, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(result.cursor).not.toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it('returns newest `limit` events (slice from tail) when buffer > limit; hasMore=false', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    for (const e of fillSeq(50)) buffer.push(e);
    const result = tailWithFilter(buffer, { limit: 10 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.length).toBe(10);
    expect(result.entries[0]?.sequenceNumber).toBe(41);
    expect(result.entries[9]?.sequenceNumber).toBe(50);
    expect(result.hasMore).toBe(false);
  });
});

describe('tailWithFilter — level filter', () => {
  it('keeps only console events whose level is in the set', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    buffer.push(make({ kind: 'console', ts: 1, sequenceNumber: 1, level: 'log' }));
    buffer.push(make({ kind: 'console', ts: 2, sequenceNumber: 2, level: 'error' }));
    buffer.push(make({ kind: 'console', ts: 3, sequenceNumber: 3, level: 'warn' }));
    buffer.push(make({ kind: 'console', ts: 4, sequenceNumber: 4, level: 'error' }));
    const result = tailWithFilter(buffer, { level: ['error'] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sequenceNumber)).toEqual([2, 4]);
  });

  it('excludes events without a `level` field when level filter is set', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    buffer.push(
      make({
        kind: 'fetch',
        ts: 1,
        sequenceNumber: 1,
        phase: 'response',
        status: 500,
      }),
    );
    buffer.push(make({ kind: 'console', ts: 2, sequenceNumber: 2, level: 'error' }));
    const result = tailWithFilter(buffer, { level: ['error'] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.kind).toBe('console');
  });
});

describe('tailWithFilter — pattern include/exclude', () => {
  it('include: keeps only events whose JSON matches a regex', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    buffer.push(
      make({ kind: 'console', ts: 1, sequenceNumber: 1, level: 'log', args: ['foo'] }),
    );
    buffer.push(
      make({
        kind: 'console',
        ts: 2,
        sequenceNumber: 2,
        level: 'error',
        args: ['TypeError: x'],
      }),
    );
    buffer.push(
      make({ kind: 'console', ts: 3, sequenceNumber: 3, level: 'log', args: ['bar'] }),
    );
    const result = tailWithFilter(
      buffer,
      { pattern: { include: ['TypeError'] } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sequenceNumber)).toEqual([2]);
  });

  it('exclude: rejects events whose JSON matches', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    buffer.push(
      make({ kind: 'console', ts: 1, sequenceNumber: 1, args: ['extension://abc'] }),
    );
    buffer.push(
      make({ kind: 'console', ts: 2, sequenceNumber: 2, args: ['user error'] }),
    );
    const result = tailWithFilter(
      buffer,
      { pattern: { exclude: ['extension://'] } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sequenceNumber)).toEqual([2]);
  });

  it('include + exclude both applied (exclude wins overlap)', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    buffer.push(
      make({
        kind: 'console',
        ts: 1,
        sequenceNumber: 1,
        args: ['TypeError extension://'],
      }),
    );
    buffer.push(
      make({
        kind: 'console',
        ts: 2,
        sequenceNumber: 2,
        args: ['TypeError app://'],
      }),
    );
    buffer.push(
      make({
        kind: 'console',
        ts: 3,
        sequenceNumber: 3,
        args: ['ReferenceError app://'],
      }),
    );
    const result = tailWithFilter(
      buffer,
      { pattern: { include: ['TypeError'], exclude: ['extension://'] } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sequenceNumber)).toEqual([2]);
  });

  it('returns pattern_invalid for malformed regex source', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(buffer, { pattern: { include: ['['] } }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('pattern_invalid');
    if (result.error.kind !== 'pattern_invalid') return;
    expect(result.error.fieldPath).toBe('pattern.include[0]');
  });

  it('reports correct fieldPath on second exclude entry failing', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(
      buffer,
      { pattern: { exclude: ['ok', '('] } },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.kind !== 'pattern_invalid') return;
    expect(result.error.fieldPath).toBe('pattern.exclude[1]');
  });
});

describe('tailWithFilter — cursor pagination (since)', () => {
  it('returns only events with seq > since.seq, oldest→newest', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    for (const e of fillSeq(10)) buffer.push(e);
    const since = encodeCursor({ sessionId: SESSION, sequenceNumber: 6 });
    const result = tailWithFilter(buffer, { since }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sequenceNumber)).toEqual([7, 8, 9, 10]);
    expect(result.hasMore).toBe(false);
  });

  it('forward page returns oldest matching slice; hasMore=true when more remain', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    for (const e of fillSeq(50)) buffer.push(e);
    const since = encodeCursor({ sessionId: SESSION, sequenceNumber: 0 });
    const result = tailWithFilter(buffer, { since, limit: 10 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.length).toBe(10);
    expect(result.entries[0]?.sequenceNumber).toBe(1);
    expect(result.entries[9]?.sequenceNumber).toBe(10);
    expect(result.hasMore).toBe(true);
  });

  it('round-trip: feeding previous response cursor as since returns only newer events', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    for (const e of fillSeq(25)) buffer.push(e);
    const first = tailWithFilter(buffer, { limit: 10 }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.entries[0]?.sequenceNumber).toBe(16);
    expect(first.entries[9]?.sequenceNumber).toBe(25);
    expect(first.cursor).not.toBeNull();
    for (const e of fillSeq(5, 26)) buffer.push(e);
    const second = tailWithFilter(
      buffer,
      { since: first.cursor as Cursor, limit: 10 },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entries.map((e) => e.sequenceNumber)).toEqual([26, 27, 28, 29, 30]);
    expect(second.hasMore).toBe(false);
  });

  it('returns cursor_session_mismatch when since cursor session differs from ctx', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    buffer.push(make({ kind: 'console', ts: 1, sequenceNumber: 1 }));
    const since = encodeCursor({ sessionId: 'OTHER', sequenceNumber: 0 });
    const result = tailWithFilter(buffer, { since }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('cursor_session_mismatch');
    if (result.error.kind !== 'cursor_session_mismatch') return;
    expect(result.error.fieldPath).toBe('since');
    expect(result.error.cursorSessionId).toBe('OTHER');
    expect(result.error.currentSessionId).toBe(SESSION);
  });

  it('returns cursor_invalid for malformed base64 cursor', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(buffer, { since: '!!!!' as Cursor }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('cursor_invalid');
    if (result.error.kind !== 'cursor_invalid') return;
    expect(result.error.fieldPath).toBe('since');
  });
});

describe('tailWithFilter — cursor pagination (until + window)', () => {
  it('until: returns events with seq < until.seq', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    for (const e of fillSeq(10)) buffer.push(e);
    const until = encodeCursor({ sessionId: SESSION, sequenceNumber: 5 });
    const result = tailWithFilter(buffer, { until }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4]);
  });

  it('since + until window: both bounds applied (exclusive)', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    for (const e of fillSeq(10)) buffer.push(e);
    const since = encodeCursor({ sessionId: SESSION, sequenceNumber: 3 });
    const until = encodeCursor({ sessionId: SESSION, sequenceNumber: 8 });
    const result = tailWithFilter(buffer, { since, until }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.sequenceNumber)).toEqual([4, 5, 6, 7]);
  });
});

describe('tailWithFilter — limit validation', () => {
  it('limit=0 rejected', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(buffer, { limit: 0 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('limit_invalid');
  });

  it('limit=-1 rejected', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(buffer, { limit: -1 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('limit_invalid');
  });

  it('limit=1.5 rejected (must be integer)', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(buffer, { limit: 1.5 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('limit_invalid');
  });

  it('limit=2000 rejected (exceeds MAX_LIMIT)', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(buffer, { limit: 2000 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('limit_invalid');
  });

  it('NaN limit rejected', () => {
    const buffer = createRingBuffer<HostStoredEvent>({ capacity: 100 });
    const result = tailWithFilter(buffer, { limit: Number.NaN }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('limit_invalid');
  });
});
