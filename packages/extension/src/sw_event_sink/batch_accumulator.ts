export interface BatchAccumulatorOptions<T> {
  readonly maxSize: number;
  readonly maxMs: number;
  readonly flush: (events: readonly T[]) => void;
}

export interface BatchAccumulator<T> {
  readonly push: (item: T) => void;
  readonly flushNow: () => void;
  readonly dispose: () => void;
}

export const createBatchAccumulator = <T>(
  opts: BatchAccumulatorOptions<T>,
): BatchAccumulator<T> => {
  if (!Number.isFinite(opts.maxSize) || opts.maxSize <= 0) {
    throw new Error(
      `createBatchAccumulator: maxSize must be > 0, got ${String(opts.maxSize)}`,
    );
  }
  if (!Number.isFinite(opts.maxMs) || opts.maxMs <= 0) {
    throw new Error(
      `createBatchAccumulator: maxMs must be > 0, got ${String(opts.maxMs)}`,
    );
  }

  const maxSize = opts.maxSize;
  const maxMs = opts.maxMs;
  const flush = opts.flush;
  const pending: T[] = [];
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timerHandle !== undefined) {
      clearTimeout(timerHandle);
      timerHandle = undefined;
    }
  };

  const flushNow = (): void => {
    clearTimer();
    if (pending.length === 0) return;
    const snapshot = pending.slice();
    pending.length = 0;
    flush(snapshot);
  };

  const push = (item: T): void => {
    pending.push(item);
    if (pending.length >= maxSize) {
      flushNow();
      return;
    }
    if (timerHandle === undefined) {
      timerHandle = setTimeout(flushNow, maxMs);
    }
  };

  const dispose = (): void => {
    clearTimer();
    pending.length = 0;
  };

  return Object.freeze({ push, flushNow, dispose });
};
