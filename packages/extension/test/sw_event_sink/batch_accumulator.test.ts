import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBatchAccumulator } from '../../src/sw_event_sink/batch_accumulator.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createBatchAccumulator — input validation', () => {
  it('throws on non-positive maxSize', () => {
    const flush = vi.fn();
    expect(() => createBatchAccumulator({ maxSize: 0, maxMs: 100, flush })).toThrow(/maxSize/);
    expect(() => createBatchAccumulator({ maxSize: -1, maxMs: 100, flush })).toThrow(/maxSize/);
    expect(() => createBatchAccumulator({ maxSize: NaN, maxMs: 100, flush })).toThrow(/maxSize/);
  });

  it('throws on non-positive maxMs', () => {
    const flush = vi.fn();
    expect(() => createBatchAccumulator({ maxSize: 50, maxMs: 0, flush })).toThrow(/maxMs/);
    expect(() => createBatchAccumulator({ maxSize: 50, maxMs: -10, flush })).toThrow(/maxMs/);
    expect(() => createBatchAccumulator({ maxSize: 50, maxMs: Infinity, flush })).toThrow(/maxMs/);
  });
});

describe('createBatchAccumulator — size threshold', () => {
  it('does not flush below maxSize', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 3, maxMs: 100, flush });
    acc.push(1);
    acc.push(2);
    expect(flush).not.toHaveBeenCalled();
  });

  it('flushes immediately on reaching maxSize', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 3, maxMs: 100, flush });
    acc.push(1);
    acc.push(2);
    acc.push(3);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('starts a fresh batch after size-trigger flush', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 2, maxMs: 100, flush });
    acc.push(1);
    acc.push(2);
    acc.push(3);
    acc.push(4);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(1, [1, 2]);
    expect(flush).toHaveBeenNthCalledWith(2, [3, 4]);
  });
});

describe('createBatchAccumulator — time threshold', () => {
  it('flushes after maxMs even below maxSize', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 50, maxMs: 100, flush });
    acc.push(1);
    acc.push(2);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith([1, 2]);
  });

  it('reschedules timer after a flush + new push', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 50, maxMs: 100, flush });
    acc.push(1);
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledOnce();
    acc.push(2);
    vi.advanceTimersByTime(99);
    expect(flush).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(2, [2]);
  });

  it('size-trigger before timer fires cancels the timer (no double flush)', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 2, maxMs: 100, flush });
    acc.push(1);
    vi.advanceTimersByTime(50);
    acc.push(2); // size threshold → immediate flush
    expect(flush).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledOnce(); // no additional fire from the cancelled timer
  });
});

describe('createBatchAccumulator — flushNow', () => {
  it('drains pending early and cancels the timer', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 50, maxMs: 100, flush });
    acc.push(1);
    acc.push(2);
    acc.flushNow();
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith([1, 2]);
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledOnce(); // timer was cancelled
  });

  it('no-ops when pending is empty (no flush call)', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 50, maxMs: 100, flush });
    acc.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('createBatchAccumulator — dispose', () => {
  it('cancels the timer without flushing pending', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 50, maxMs: 100, flush });
    acc.push(1);
    acc.push(2);
    acc.dispose();
    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();
  });

  it('drops pending so subsequent flushNow has nothing to flush', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<number>({ maxSize: 50, maxMs: 100, flush });
    acc.push(1);
    acc.dispose();
    acc.flushNow();
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('createBatchAccumulator — semantics', () => {
  it('preserves push order in the flushed batch', () => {
    const flush = vi.fn();
    const acc = createBatchAccumulator<string>({ maxSize: 3, maxMs: 100, flush });
    acc.push('a');
    acc.push('b');
    acc.push('c');
    expect(flush).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('flush callback receives a defensive copy — subsequent pushes do not mutate the prior batch', () => {
    const captured: number[][] = [];
    const flush = (events: readonly number[]): void => {
      captured.push(events as number[]);
    };
    const acc = createBatchAccumulator<number>({ maxSize: 2, maxMs: 100, flush });
    acc.push(1);
    acc.push(2);
    acc.push(3);
    acc.push(4);
    expect(captured[0]).toEqual([1, 2]);
    expect(captured[1]).toEqual([3, 4]);
  });
});
