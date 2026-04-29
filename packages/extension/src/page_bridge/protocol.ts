export const PAGE_BRIDGE_NS = 'pwa-debug' as const;
export type PageBridgeNs = typeof PAGE_BRIDGE_NS;

export type PageBridgeDir = 'cs->page' | 'page->cs' | 'page-event';

export type PageBridgeRequestEnvelope = {
  readonly ns: PageBridgeNs;
  readonly dir: 'cs->page';
  readonly requestId: string;
  readonly tool: string;
  readonly payload?: unknown;
};

export type PageBridgeResponseEnvelope = {
  readonly ns: PageBridgeNs;
  readonly dir: 'page->cs';
  readonly requestId: string;
  readonly payload?: unknown;
  readonly error?: { readonly message: string };
};

export type PageBridgeEventEnvelope<T = unknown> = {
  readonly ns: PageBridgeNs;
  readonly dir: 'page-event';
  readonly event: T;
};

export type PageBridgeEnvelope =
  | PageBridgeRequestEnvelope
  | PageBridgeResponseEnvelope
  | PageBridgeEventEnvelope<unknown>;

export type EncodeRequestInput = {
  readonly requestId: string;
  readonly tool: string;
  readonly payload?: unknown;
};

export type EncodeResponseInput = {
  readonly requestId: string;
  readonly payload?: unknown;
  readonly error?: { readonly message: string };
};

export const encodeRequest = (
  input: EncodeRequestInput,
): PageBridgeRequestEnvelope => {
  const base = {
    ns: PAGE_BRIDGE_NS,
    dir: 'cs->page' as const,
    requestId: input.requestId,
    tool: input.tool,
  };
  return Object.freeze(
    input.payload === undefined ? base : { ...base, payload: input.payload },
  );
};

export const encodeResponse = (
  input: EncodeResponseInput,
): PageBridgeResponseEnvelope => {
  const base: {
    ns: PageBridgeNs;
    dir: 'page->cs';
    requestId: string;
    payload?: unknown;
    error?: { readonly message: string };
  } = {
    ns: PAGE_BRIDGE_NS,
    dir: 'page->cs',
    requestId: input.requestId,
  };
  if (input.payload !== undefined) base.payload = input.payload;
  if (input.error !== undefined) {
    base.error = Object.freeze({ message: input.error.message });
  }
  return Object.freeze(base);
};

const isPageBridgeNs = (v: unknown): v is PageBridgeNs => v === PAGE_BRIDGE_NS;

export const isInboundCsToPage = (
  event: MessageEvent,
): event is MessageEvent<PageBridgeRequestEnvelope> => {
  if (event.source !== window) return false;
  const data = event.data;
  if (data === null || typeof data !== 'object') return false;
  const r = data as Record<string, unknown>;
  return (
    isPageBridgeNs(r['ns']) &&
    r['dir'] === 'cs->page' &&
    typeof r['requestId'] === 'string' &&
    typeof r['tool'] === 'string'
  );
};

export const isInboundPageToCs = (
  event: MessageEvent,
): event is MessageEvent<PageBridgeResponseEnvelope> => {
  if (event.source !== window) return false;
  const data = event.data;
  if (data === null || typeof data !== 'object') return false;
  const r = data as Record<string, unknown>;
  return (
    isPageBridgeNs(r['ns']) &&
    r['dir'] === 'page->cs' &&
    typeof r['requestId'] === 'string'
  );
};

export const encodeEvent = <T>(event: T): PageBridgeEventEnvelope<T> =>
  Object.freeze({
    ns: PAGE_BRIDGE_NS,
    dir: 'page-event' as const,
    event,
  });

export const isInboundPageEvent = (
  event: MessageEvent,
): event is MessageEvent<PageBridgeEventEnvelope<unknown>> => {
  if (event.source !== window) return false;
  const data = event.data;
  if (data === null || typeof data !== 'object') return false;
  const r = data as Record<string, unknown>;
  return (
    isPageBridgeNs(r['ns']) &&
    r['dir'] === 'page-event' &&
    'event' in r
  );
};
