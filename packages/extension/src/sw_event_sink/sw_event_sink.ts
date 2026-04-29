import {
  PAGE_EVENT_SW_TAG,
  type PageEventSwMessage,
} from '../page_bridge/cs_dispatcher.js';
import type { CapturedEvent } from '../captures/types.js';

export type EventSinkStats = {
  readonly totalReceived: number;
  readonly perKind: Readonly<Record<string, number>>;
};

export type EventSink = {
  readonly handle: (event: CapturedEvent) => void;
  readonly getStats: () => EventSinkStats;
};

export type EventSinkInput = {
  readonly logger?: (event: CapturedEvent) => void;
};

export const createEventSink = (input: EventSinkInput = {}): EventSink => {
  const logger = input.logger;
  const perKind: Record<string, number> = {};
  let totalReceived = 0;

  const handle = (event: CapturedEvent): void => {
    const kind = event.kind;
    perKind[kind] = (perKind[kind] ?? 0) + 1;
    totalReceived += 1;
    if (logger !== undefined) {
      try {
        logger(event);
      } catch {
        // Logger failures must not interrupt event ingestion.
      }
    }
  };

  const getStats = (): EventSinkStats =>
    Object.freeze({
      totalReceived,
      perKind: Object.freeze({ ...perKind }),
    });

  return Object.freeze({ handle, getStats });
};

export const isPageEventSwMessage = (
  msg: unknown,
): msg is PageEventSwMessage => {
  if (msg === null || typeof msg !== 'object') return false;
  const r = msg as Record<string, unknown>;
  return r['tag'] === PAGE_EVENT_SW_TAG && 'event' in r;
};
