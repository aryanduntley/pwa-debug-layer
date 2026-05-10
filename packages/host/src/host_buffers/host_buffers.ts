export interface RingBufferOptions<T extends { ts: number }> {
  readonly capacity: number;
  readonly onEvict?: (evicted: T) => void;
}

export interface RingBufferTailOptions<T extends { ts: number }> {
  readonly since?: number;
  readonly limit?: number;
  readonly filter?: (entry: T) => boolean;
}

export interface RingBuffer<T extends { ts: number }> {
  readonly push: (item: T) => void;
  readonly tail: (opts?: RingBufferTailOptions<T>) => T[];
  readonly size: () => number;
  readonly clear: () => void;
}

export const createRingBuffer = <T extends { ts: number }>(
  opts: RingBufferOptions<T>,
): RingBuffer<T> => {
  if (!Number.isInteger(opts.capacity) || opts.capacity <= 0) {
    throw new Error(
      `createRingBuffer: capacity must be a positive integer, got ${String(opts.capacity)}`,
    );
  }

  const capacity = opts.capacity;
  const onEvict = opts.onEvict;
  const slots: Array<T | undefined> = new Array<T | undefined>(capacity);
  let writeIndex = 0;
  let count = 0;

  const push = (item: T): void => {
    if (count < capacity) {
      slots[writeIndex] = item;
      writeIndex = (writeIndex + 1) % capacity;
      count++;
      return;
    }
    const evicted = slots[writeIndex] as T;
    slots[writeIndex] = item;
    writeIndex = (writeIndex + 1) % capacity;
    if (onEvict !== undefined) onEvict(evicted);
  };

  const tail = (tailOpts?: RingBufferTailOptions<T>): T[] => {
    const since = tailOpts?.since;
    const limit = tailOpts?.limit;
    const filter = tailOpts?.filter;

    const startIndex = count < capacity ? 0 : writeIndex;
    const matched: T[] = [];
    for (let i = 0; i < count; i++) {
      const entry = slots[(startIndex + i) % capacity] as T;
      if (since !== undefined && !(entry.ts > since)) continue;
      if (filter !== undefined && !filter(entry)) continue;
      matched.push(entry);
    }
    if (limit !== undefined && matched.length > limit) {
      return matched.slice(matched.length - limit);
    }
    return matched;
  };

  const size = (): number => count;

  const clear = (): void => {
    for (let i = 0; i < capacity; i++) slots[i] = undefined;
    writeIndex = 0;
    count = 0;
  };

  return Object.freeze({ push, tail, size, clear });
};
