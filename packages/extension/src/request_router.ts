export type SwRequestEnvelope = {
  readonly type: 'request';
  readonly requestId: string;
  readonly tool: string;
  readonly extensionId?: string;
  readonly payload?: unknown;
};

export type SwResponseEnvelope = {
  readonly type: 'response';
  readonly requestId: string;
  readonly payload?: unknown;
  readonly error?: { readonly message: string };
};

type RequestHandler = (env: SwRequestEnvelope) => Promise<unknown>;

export const isSwRequestEnvelope = (m: unknown): m is SwRequestEnvelope => {
  if (m === null || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return (
    r['type'] === 'request' &&
    typeof r['requestId'] === 'string' &&
    typeof r['tool'] === 'string'
  );
};

const handleSessionPing: RequestHandler = async () => {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const attachedTabId = tabs[0]?.id ?? null;
  const extensionVersion = chrome.runtime.getManifest().version;
  return { extensionVersion, attachedTabId };
};

const HANDLERS: Readonly<Record<string, RequestHandler>> = Object.freeze({
  session_ping: handleSessionPing,
});

const errorResponse = (
  requestId: string,
  message: string,
): SwResponseEnvelope =>
  Object.freeze({
    type: 'response',
    requestId,
    error: Object.freeze({ message }),
  });

const okResponse = (
  requestId: string,
  payload: unknown,
): SwResponseEnvelope =>
  Object.freeze({
    type: 'response',
    requestId,
    payload,
  });

export const routeRequest = async (
  env: SwRequestEnvelope,
): Promise<SwResponseEnvelope> => {
  const handler = HANDLERS[env.tool];
  if (!handler) {
    return errorResponse(env.requestId, `unknown tool: ${env.tool}`);
  }
  try {
    const payload = await handler(env);
    return okResponse(env.requestId, payload);
  } catch (err) {
    return errorResponse(env.requestId, (err as Error).message);
  }
};
