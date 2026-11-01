/** Why a CDP operation failed. */
export type CdpErrorKind =
  | 'no_websocket'
  | 'connect_failed'
  | 'timeout'
  | 'closed'
  | 'protocol'
  | 'http'
  | 'bad_body';

export type CdpError = Error & {
  readonly name: 'CdpError';
  readonly kind: CdpErrorKind;
  /** CDP error code, for kind 'protocol'. */
  readonly code?: number;
};

export const cdpError = (kind: CdpErrorKind, message: string, code?: number): CdpError =>
  Object.assign(new Error(message), {
    name: 'CdpError' as const,
    kind,
    ...(code !== undefined ? { code } : {}),
  });

export const isCdpError = (v: unknown): v is CdpError =>
  v instanceof Error && (v as { name?: unknown }).name === 'CdpError' &&
  typeof (v as { kind?: unknown }).kind === 'string';

/** The subset of the WHATWG WebSocket the client uses. */
export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
};

export type WebSocketCtor = new (url: string) => WebSocketLike;

export type CdpClientOptions = {
  /** Defaults to globalThis.WebSocket (Node 22+). */
  readonly WebSocketImpl?: WebSocketCtor;
  readonly connectTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
};

export type CdpSendOptions = {
  readonly timeoutMs?: number;
  /** Flattened Target session to address (browser-socket sessions). */
  readonly sessionId?: string;
};

export type CdpEventHandler = (params: unknown, sessionId?: string) => void;

export type CdpClient = {
  readonly send: (
    method: string,
    params?: Record<string, unknown>,
    opts?: CdpSendOptions,
  ) => Promise<unknown>;
  readonly on: (method: string, handler: CdpEventHandler) => () => void;
  readonly onClose: (handler: () => void) => () => void;
  readonly close: () => void;
  readonly isOpen: () => boolean;
};
