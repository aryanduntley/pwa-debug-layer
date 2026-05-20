import type {
  ConsoleCapturedEvent,
  FetchCapturedEvent,
  XhrCapturedEvent,
  WebSocketCapturedEvent,
  StoreChangeCapturedEvent,
  ReplayCapturedEvent,
} from './captured_event.js';
import type { Cursor } from './filter_spec.js';

export type EntryEnvelope = {
  readonly receivedAt: number;
  readonly sessionId: string;
  readonly extensionId: string;
  readonly cursor: Cursor;
};

export type ConsoleEntry = ConsoleCapturedEvent & EntryEnvelope;

export type NetworkEntry =
  | (FetchCapturedEvent & EntryEnvelope)
  | (XhrCapturedEvent & EntryEnvelope)
  | (WebSocketCapturedEvent & EntryEnvelope);

export type StoreChangeEntry = StoreChangeCapturedEvent & EntryEnvelope;

export type ReplayEntry = ReplayCapturedEvent & EntryEnvelope;
