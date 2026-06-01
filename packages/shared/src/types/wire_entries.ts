import type {
  ConsoleCapturedEvent,
  FetchCapturedEvent,
  XhrCapturedEvent,
  WebSocketCapturedEvent,
  StoreChangeCapturedEvent,
  ReplayCapturedEvent,
  PopupCapturedEvent,
  PageErrorCapturedEvent,
  SwStateCapturedEvent,
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

export type PopupEntry = PopupCapturedEvent & EntryEnvelope;

export type PageErrorEntry = PageErrorCapturedEvent & EntryEnvelope;

export type SwStateEntry = SwStateCapturedEvent & EntryEnvelope;

/** An uncaught page error correlated to an open popup window by popup_failures. */
export type PopupPageError = {
  readonly subkind: string;
  readonly message: string;
  readonly name?: string;
  readonly ts: number;
  readonly sequenceNumber: number;
};

/** A console error correlated to an open popup window by the popup_failures tool. */
export type PopupConsoleError = {
  readonly level: string;
  readonly text: string;
  readonly ts: number;
  readonly sequenceNumber: number;
};

/** A failed network request correlated to an open popup window by popup_failures. */
export type PopupNetworkError = {
  readonly kind: string;
  readonly url?: string;
  readonly method?: string;
  readonly status?: number;
  readonly phase?: string;
  readonly ts: number;
  readonly sequenceNumber: number;
};

/** The time window a popup was open (open=true when no 'disappeared' seen yet, to=now). */
export type PopupFailureWindow = {
  readonly from: number;
  readonly to: number;
  readonly open: boolean;
};

/**
 * Per-popup failure report from the popup_failures MCP tool: the in-widget
 * failure reason/alerts (from PopupState) plus the console errors and failed
 * network requests captured during the popup's open window (matched by frameKey).
 */
export type PopupFailureReport = {
  readonly popupId: string;
  readonly library: string;
  readonly detection: 'shadow' | 'portal';
  readonly frameKey: string;
  /** 'primary' (one report per logical widget; the default) or 'nested'. */
  readonly role?: 'primary' | 'nested';
  /** popupId of the immediate enclosing popup, null for a primary. */
  readonly parentPopupId?: string | null;
  readonly reason?: string;
  readonly alerts?: readonly string[];
  readonly window: PopupFailureWindow;
  readonly console: readonly PopupConsoleError[];
  readonly network: readonly PopupNetworkError[];
  /** Uncaught window errors / unhandled rejections in the window (same frame). */
  readonly errors: readonly PopupPageError[];
};
