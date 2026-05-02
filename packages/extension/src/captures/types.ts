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

export type NodeSummary = {
  readonly nodeId: string;
  readonly nodeType: number;
  readonly tagName?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly childCount?: number;
  readonly textContent?: string;
  readonly truncated?: boolean;
};

export type DomMutationPatch =
  | {
      readonly kind: 'childList';
      readonly target: NodeSummary;
      readonly added: readonly NodeSummary[];
      readonly removed: readonly NodeSummary[];
    }
  | {
      readonly kind: 'attributes';
      readonly target: NodeSummary;
      readonly name: string;
      readonly oldValue: string | null;
      readonly newValue: string | null;
    }
  | {
      readonly kind: 'characterData';
      readonly target: NodeSummary;
      readonly oldValue: string;
      readonly newValue: string;
    }
  | {
      readonly kind: 'overflow';
      readonly dropped: number;
    };

export type DomMutationCapturedEvent = CaptureMeta & {
  readonly kind: 'dom_mutation';
  readonly patches: readonly DomMutationPatch[];
};

export type DomMutationCaptureOptions = {
  readonly depthCap?: number;
  readonly coalesceWindowMs?: number;
  readonly maxPatchesPerEvent?: number;
};

export type CapturedEvent =
  | ConsoleCapturedEvent
  | FetchCapturedEvent
  | XhrCapturedEvent
  | WebSocketCapturedEvent
  | DomMutationCapturedEvent;
