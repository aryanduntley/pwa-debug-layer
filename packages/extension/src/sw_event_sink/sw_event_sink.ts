import {
  PAGE_EVENT_SW_TAG,
  type PageEventSwMessage,
} from '../page_bridge/cs_dispatcher.js';
import type { CapturedEvent } from '../captures/types.js';
import {
  createBatchAccumulator,
  type BatchAccumulator,
} from './batch_accumulator.js';

const DEFAULT_BUFFER_SIZE = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_FORWARD_MAX_SIZE = 50;
const DEFAULT_FORWARD_MAX_MS = 100;

export type EventSinkStats = {
  readonly totalReceived: number;
  readonly perKind: Readonly<Record<string, number>>;
  readonly bufferSize: number;
};

export type GetRecentFilter = {
  readonly kinds?: readonly string[];
  readonly sinceMs?: number;
  readonly limit?: number;
};

export type GetRecentResult = {
  readonly events: readonly CapturedEvent[];
  readonly stats: EventSinkStats;
};

export type EventSink = {
  readonly handle: (event: CapturedEvent) => void;
  readonly getStats: () => EventSinkStats;
  readonly getRecent: (filter?: GetRecentFilter) => GetRecentResult;
  readonly flushNow: () => void;
  readonly dispose: () => void;
};

export type EventSinkInput = {
  readonly logger?: (event: CapturedEvent) => void;
  readonly bufferSize?: number;
  readonly forwardEvents?: (events: readonly CapturedEvent[]) => void;
  readonly forwardMaxSize?: number;
  readonly forwardMaxMs?: number;
};

export const createEventSink = (input: EventSinkInput = {}): EventSink => {
  const logger = input.logger;
  const bufferSize =
    input.bufferSize !== undefined && input.bufferSize > 0
      ? Math.floor(input.bufferSize)
      : DEFAULT_BUFFER_SIZE;
  const buffer: CapturedEvent[] = [];
  let writeIndex = 0;
  const perKind: Record<string, number> = {};
  let totalReceived = 0;

  const forwardAcc: BatchAccumulator<CapturedEvent> | undefined =
    input.forwardEvents !== undefined
      ? createBatchAccumulator<CapturedEvent>({
          maxSize: input.forwardMaxSize ?? DEFAULT_FORWARD_MAX_SIZE,
          maxMs: input.forwardMaxMs ?? DEFAULT_FORWARD_MAX_MS,
          flush: input.forwardEvents,
        })
      : undefined;

  const snapshotStats = (): EventSinkStats =>
    Object.freeze({
      totalReceived,
      perKind: Object.freeze({ ...perKind }),
      bufferSize,
    });

  const handle = (event: CapturedEvent): void => {
    perKind[event.kind] = (perKind[event.kind] ?? 0) + 1;
    totalReceived += 1;
    if (buffer.length < bufferSize) {
      buffer.push(event);
    } else {
      buffer[writeIndex] = event;
    }
    writeIndex = (writeIndex + 1) % bufferSize;
    if (logger !== undefined) {
      try {
        logger(event);
      } catch {
        // Logger failures must not interrupt event ingestion.
      }
    }
    if (forwardAcc !== undefined) {
      forwardAcc.push(event);
    }
  };

  const getStats = (): EventSinkStats => snapshotStats();

  const getRecent = (filter: GetRecentFilter = {}): GetRecentResult => {
    const ordered: CapturedEvent[] = [];
    if (buffer.length < bufferSize) {
      for (let i = 0; i < buffer.length; i++) {
        ordered.push(buffer[i]!);
      }
    } else {
      for (let i = 0; i < bufferSize; i++) {
        ordered.push(buffer[(writeIndex + i) % bufferSize]!);
      }
    }
    const kindsSet =
      filter.kinds !== undefined && filter.kinds.length > 0
        ? new Set(filter.kinds)
        : undefined;
    const afterKinds =
      kindsSet === undefined
        ? ordered
        : ordered.filter((e) => kindsSet.has(e.kind));
    const sinceMs = filter.sinceMs;
    const afterSince =
      sinceMs === undefined
        ? afterKinds
        : afterKinds.filter((e) => e.ts > sinceMs);
    const requested =
      filter.limit !== undefined ? Math.floor(filter.limit) : DEFAULT_LIMIT;
    const cap = Math.max(0, Math.min(requested, bufferSize));
    const events =
      afterSince.length > cap
        ? afterSince.slice(afterSince.length - cap)
        : afterSince;
    return Object.freeze({
      events: Object.freeze([...events]),
      stats: snapshotStats(),
    });
  };

  const flushNow = (): void => {
    forwardAcc?.flushNow();
  };

  const dispose = (): void => {
    forwardAcc?.dispose();
  };

  return Object.freeze({ handle, getStats, getRecent, flushNow, dispose });
};

export const isPageEventSwMessage = (
  msg: unknown,
): msg is PageEventSwMessage => {
  if (msg === null || typeof msg !== 'object') return false;
  const r = msg as Record<string, unknown>;
  return r['tag'] === PAGE_EVENT_SW_TAG && 'event' in r;
};
