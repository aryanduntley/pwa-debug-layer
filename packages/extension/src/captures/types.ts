export type CaptureMeta = {
  readonly ts: number;
  readonly frameUrl: string;
  readonly frameKey: string;
};

export type ConsoleLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace';

export type ConsoleCapturedEvent = CaptureMeta & {
  readonly kind: 'console';
  readonly level: ConsoleLevel;
  readonly args: readonly unknown[];
  readonly stack?: string;
};

export type FetchCapturedEvent = CaptureMeta & {
  readonly kind: 'fetch';
  readonly phase: 'request' | 'response' | 'error';
  readonly captureId: string;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly body?: unknown;
  readonly durationMs?: number;
};

export type XhrCapturedEvent = CaptureMeta & {
  readonly kind: 'xhr';
  readonly phase: 'request' | 'response' | 'error';
  readonly captureId: string;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly responseType?: string;
  readonly body?: unknown;
  readonly durationMs?: number;
};

export type WebSocketCapturedEvent = CaptureMeta & {
  readonly kind: 'websocket';
  readonly subkind: 'open' | 'frame' | 'close' | 'error';
  readonly connectionId: string;
  readonly url?: string;
  readonly direction?: 'send' | 'receive';
  readonly frameType?: 'text' | 'binary';
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
};

export type CapturedEvent =
  | ConsoleCapturedEvent
  | FetchCapturedEvent
  | XhrCapturedEvent
  | WebSocketCapturedEvent;
