import {
  CDP_EMIT_BINDING,
  CDP_GLOBAL,
  normalizeUrl,
  type CdpDispatchRequest,
} from '@pwa-debug/shared';
import type { HostCapturedEvent } from '../captures_in/captures_in.js';
import { CAPTURES_EVENT_TOOL } from '../captures_in/captures_in.js';
import type {
  IpcEventEnvelope,
  IpcResponseEnvelope,
} from '../mcp/ipc/envelope.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

const errorResponse = (requestId: string, message: string): IpcResponseEnvelope =>
  Object.freeze({ type: 'response', requestId, error: Object.freeze({ message }) });

/**
 * Expression that calls the in-page dispatcher. The request is JSON-encoded
 * twice so the payload, whatever it holds, arrives as one string literal.
 */
export const buildDispatchExpression = (req: CdpDispatchRequest): string =>
  `globalThis.${CDP_GLOBAL}.dispatch(${JSON.stringify(JSON.stringify(req))})`;

const MISSING_BRIDGE =
  'the pwa-debug CDP bridge is not present in this page. It may still be loading, or the page navigated somewhere it could not be injected. Retry, or detach and attach again with reload:true.';

/**
 * Map a Runtime.evaluate result (awaitPromise + returnByValue) for a dispatch
 * call to the IPC response shape the tool layer already handles.
 */
export const parseDispatchResult = (requestId: string, raw: unknown): IpcResponseEnvelope => {
  if (!isRecord(raw)) return errorResponse(requestId, 'cdp: empty Runtime.evaluate result');
  const exception = raw['exceptionDetails'];
  if (isRecord(exception)) {
    const ex = exception['exception'];
    const description = isRecord(ex) && typeof ex['description'] === 'string' ? ex['description'] : '';
    if (/Cannot read propert(y|ies) of undefined|is not defined|undefined is not an object/.test(description)) {
      return errorResponse(requestId, MISSING_BRIDGE);
    }
    const text = typeof exception['text'] === 'string' ? exception['text'] : 'exception';
    return errorResponse(requestId, `cdp: page threw: ${description || text}`);
  }
  const result = raw['result'];
  const value = isRecord(result) ? result['value'] : undefined;
  if (typeof value !== 'string') return errorResponse(requestId, MISSING_BRIDGE);
  let page: unknown;
  try {
    page = JSON.parse(value);
  } catch {
    return errorResponse(requestId, 'cdp: bridge returned non-JSON');
  }
  if (!isRecord(page)) return errorResponse(requestId, 'cdp: bridge returned a non-object');
  const err = page['error'];
  if (isRecord(err) && typeof err['message'] === 'string') {
    return errorResponse(requestId, err['message']);
  }
  return Object.freeze({
    type: 'response',
    requestId,
    ...(page['payload'] !== undefined ? { payload: page['payload'] } : {}),
  });
};

/** One bridge event from a Runtime.bindingCalled notification, or null. */
export const parseBindingEvent = (params: unknown): HostCapturedEvent | null => {
  if (!isRecord(params) || params['name'] !== CDP_EMIT_BINDING) return null;
  const payload = params['payload'];
  if (typeof payload !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const event = parsed['event'];
  if (!isRecord(event) || typeof event['kind'] !== 'string' || typeof event['ts'] !== 'number') {
    return null;
  }
  return event as HostCapturedEvent;
};

/** The envelope the captures intake accepts from any connection. */
export const capturesEnvelope = (
  connectionId: string,
  events: readonly HostCapturedEvent[],
): IpcEventEnvelope =>
  Object.freeze({
    type: 'event',
    tool: CAPTURES_EVENT_TOOL,
    extensionId: connectionId,
    payload: Object.freeze({ events }),
  });

/** True for connection ids minted by the CDP transport. */
export const isCdpConnectionId = (id: string): boolean => id.startsWith('cdp:');

/** 'cdp:<host>:<port>:<first 8 of targetId>' */
export const cdpConnectionId = (baseUrl: string, targetId: string): string => {
  const hostPort = baseUrl.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  return `cdp:${hostPort}:${targetId.slice(0, 8)}`;
};

/** pdl_navigate URL rules, shared with the extension (normalizeUrl). */
export const normalizeNavigateUrl = (
  raw: unknown,
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly error: string } => {
  const url = typeof raw === 'string' ? normalizeUrl(raw) : null;
  return url !== null
    ? { ok: true, url }
    : { ok: false, error: 'pdl_navigate: url must be a non-empty string and not a javascript: URL' };
};

/** A CDP connection is a single tab, so tab_id has no meaning there. */
export const stripTabId = (payload: unknown): unknown => {
  if (!isRecord(payload) || !('tab_id' in payload)) return payload;
  const { tab_id: _drop, ...rest } = payload;
  return rest;
};
