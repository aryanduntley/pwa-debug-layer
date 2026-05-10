import { describe, it, expect, vi } from 'vitest';
import { createRingBuffer } from '../../src/host_buffers/host_buffers.js';

interface E {
  ts: number;
  v: number;
}
const e = (ts: number, v: number = ts): E => ({ ts, v });

describe('createRingBuffer — capacity invariants', () => {
  it('throws on capacity <= 0', () => {
    expect(() => createRingBuffer<E>({ capacity: 0 })).toThrow(/positive integer/);
    expect(() => createRingBuffer<E>({ capacity: -1 })).toThrow(/positive integer/);
  });

  it('throws on non-integer capacity', () => {
    expect(() => createRingBuffer<E>({ capacity: 1.5 })).toThrow(/positive integer/);
    expect(() => createRingBuffer<E>({ capacity: NaN })).toThrow(/positive integer/);
    expect(() => createRingBuffer<E>({ capacity: Infinity })).toThrow(/positive integer/);
  });

  it('size never exceeds capacity', () => {
    const rb = createRingBuffer<E>({ capacity: 3 });
    for (let i = 0; i < 10; i++) rb.push(e(i));
    expect(rb.size()).toBe(3);
  });
});

describe('createRingBuffer — FIFO eviction + onEvict', () => {
  it('evicts oldest first and onEvict fires only on overflow', () => {
    const evicted: E[] = [];
    const rb = createRingBuffer<E>({
      capacity: 2,
      onEvict: (item) => evicted.push(item),
    });

    rb.push(e(1));
    rb.push(e(2));
    expect(evicted).toEqual([]); // no overflow yet

    rb.push(e(3));
    expect(evicted).toEqual([e(1)]); // oldest dropped

    rb.push(e(4));
    expect(evicted).toEqual([e(1), e(2)]); // FIFO order

    expect(rb.tail()).toEqual([e(3), e(4)]);
  });

  it('onEvict not fired when push is within capacity', () => {
    const onEvict = vi.fn();
    const rb = createRingBuffer<E>({ capacity: 5, onEvict });
    for (let i = 1; i <= 5; i++) rb.push(e(i));
    expect(onEvict).not.toHaveBeenCalled();
    rb.push(e(6));
    expect(onEvict).toHaveBeenCalledOnce();
    expect(onEvict).toHaveBeenCalledWith(e(1));
  });

  it('onEvict optional — push works without it', () => {
    const rb = createRingBuffer<E>({ capacity: 1 });
    expect(() => {
      rb.push(e(1));
      rb.push(e(2));
    }).not.toThrow();
    expect(rb.tail()).toEqual([e(2)]);
  });
});

describe('RingBuffer.tail — query options', () => {
  const seed = (rb: ReturnType<typeof createRingBuffer<E>>) => {
    for (let i = 1; i <= 5; i++) rb.push(e(i));
  };

  it('returns all entries oldest→newest with no opts', () => {
    const rb = createRingBuffer<E>({ capacity: 5 });
    seed(rb);
    expect(rb.tail()).toEqual([e(1), e(2), e(3), e(4), e(5)]);
  });

  it('since is strict greater-than (boundary excluded)', () => {
    const rb = createRingBuffer<E>({ capacity: 5 });
    seed(rb);
    expect(rb.tail({ since: 3 })).toEqual([e(4), e(5)]);
    expect(rb.tail({ since: 0 })).toEqual([e(1), e(2), e(3), e(4), e(5)]);
    expect(rb.tail({ since: 5 })).toEqual([]);
  });

  it('limit caps to most-recent N (oldest→newest order preserved)', () => {
    const rb = createRingBuffer<E>({ capacity: 5 });
    seed(rb);
    expect(rb.tail({ limit: 2 })).toEqual([e(4), e(5)]);
    expect(rb.tail({ limit: 0 })).toEqual([]);
    expect(rb.tail({ limit: 99 })).toEqual([e(1), e(2), e(3), e(4), e(5)]);
  });

  it('filter applied before limit', () => {
    const rb = createRingBuffer<E>({ capacity: 5 });
    seed(rb);
    const evens = rb.tail({ filter: (x) => x.ts % 2 === 0 });
    expect(evens).toEqual([e(2), e(4)]);
  });

  it('combines since + filter + limit', () => {
    const rb = createRingBuffer<E>({ capacity: 10 });
    for (let i = 1; i <= 10; i++) rb.push(e(i));
    const got = rb.tail({
      since: 2,
      filter: (x) => x.ts % 2 === 0,
      limit: 2,
    });
    // ts > 2 → 3..10; even → 4,6,8,10; last 2 → 8,10
    expect(got).toEqual([e(8), e(10)]);
  });

  it('returns oldest→newest after wrap-around eviction', () => {
    const rb = createRingBuffer<E>({ capacity: 3 });
    for (let i = 1; i <= 7; i++) rb.push(e(i));
    expect(rb.tail()).toEqual([e(5), e(6), e(7)]);
  });
});

describe('RingBuffer.size + clear', () => {
  it('size reflects pushed count', () => {
    const rb = createRingBuffer<E>({ capacity: 5 });
    expect(rb.size()).toBe(0);
    rb.push(e(1));
    expect(rb.size()).toBe(1);
    for (let i = 2; i <= 10; i++) rb.push(e(i));
    expect(rb.size()).toBe(5);
  });

  it('clear empties without firing onEvict', () => {
    const onEvict = vi.fn();
    const rb = createRingBuffer<E>({ capacity: 3, onEvict });
    rb.push(e(1));
    rb.push(e(2));
    rb.clear();
    expect(rb.size()).toBe(0);
    expect(rb.tail()).toEqual([]);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it('push after clear starts fresh', () => {
    const rb = createRingBuffer<E>({ capacity: 2 });
    rb.push(e(1));
    rb.push(e(2));
    rb.clear();
    rb.push(e(99));
    expect(rb.tail()).toEqual([e(99)]);
    expect(rb.size()).toBe(1);
  });
});
