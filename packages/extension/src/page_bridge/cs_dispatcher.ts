import {
  encodeRequest,
  isInboundPageToCs,
  type PageBridgeResponseEnvelope,
} from './protocol.js';

export type CsToolRequest = {
  readonly tool: string;
  readonly payload?: unknown;
};

export type CsToolResponse = {
  readonly payload?: unknown;
  readonly error?: { readonly message: string };
};

type SendResponseFn = (response: CsToolResponse) => void;

export type CsDispatcher = {
  readonly handleSwRequest: (
    req: CsToolRequest,
    sendResponse: SendResponseFn,
  ) => void;
  readonly handlePageMessage: (event: MessageEvent) => void;
  readonly dispose: () => void;
};

export type CsDispatcherInput = {
  readonly timeoutMs?: number;
  readonly generateRequestId?: () => string;
};

const DEFAULT_TIMEOUT_MS = 4000;

export const isCsToolRequest = (m: unknown): m is CsToolRequest => {
  if (m === null || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return typeof r['tool'] === 'string';
};

type PendingEntry = {
  readonly sendResponse: SendResponseFn;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
};

export const createCsDispatcher = (
  input: CsDispatcherInput = {},
): CsDispatcher => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const generateRequestId =
    input.generateRequestId ?? (() => crypto.randomUUID());
  const pending = new Map<string, PendingEntry>();

  const finish = (requestId: string, response: CsToolResponse): void => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timeoutHandle);
    try {
      entry.sendResponse(response);
    } catch {
      // sendResponse throws if the SW message channel was closed; safe to ignore.
    }
  };

  const handleSwRequest = (
    req: CsToolRequest,
    sendResponse: SendResponseFn,
  ): void => {
    const requestId = generateRequestId();
    const envelope = encodeRequest({
      requestId,
      tool: req.tool,
      payload: req.payload,
    });
    const timeoutHandle = setTimeout(() => {
      finish(requestId, {
        error: {
          message: `page-bridge timeout after ${timeoutMs}ms (tool=${req.tool})`,
        },
      });
    }, timeoutMs);
    pending.set(requestId, { sendResponse, timeoutHandle });
    window.postMessage(envelope, window.location.origin);
  };

  const handlePageMessage = (event: MessageEvent): void => {
    if (!isInboundPageToCs(event)) return;
    const env = event.data as PageBridgeResponseEnvelope;
    const response: CsToolResponse = {};
    if (env.payload !== undefined) {
      (response as { payload?: unknown }).payload = env.payload;
    }
    if (env.error !== undefined) {
      (response as { error?: { message: string } }).error = env.error;
    }
    finish(env.requestId, response);
  };

  const dispose = (): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeoutHandle);
    }
    pending.clear();
  };

  return Object.freeze({ handleSwRequest, handlePageMessage, dispose });
};
