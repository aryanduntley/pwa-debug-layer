import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PAGE_EVENT_SW_TAG,
  createCsDispatcher,
  isCsToolRequest,
  type CsToolResponse,
  type PageEventSwMessage,
} from '../../src/page_bridge/cs_dispatcher.js';
import {
  PAGE_BRIDGE_NS,
  encodeEvent,
  encodeResponse,
  type PageBridgeRequestEnvelope,
} from '../../src/page_bridge/protocol.js';

const captureLastPostedRequest = (): {
  spy: ReturnType<typeof vi.spyOn>;
  last: () => PageBridgeRequestEnvelope | undefined;
} => {
  const sent: PageBridgeRequestEnvelope[] = [];
  const spy = vi
    .spyOn(window, 'postMessage')
    .mockImplementation((data: unknown) => {
      sent.push(data as PageBridgeRequestEnvelope);
    });
  return { spy, last: () => sent[sent.length - 1] };
};

const makePageMessageEvent = (data: unknown): MessageEvent =>
  new MessageEvent('message', {
    data,
    source: window as MessageEventSource,
  });

describe('isCsToolRequest', () => {
  it('accepts an object with a string tool field', () => {
    expect(isCsToolRequest({ tool: 'session_ping' })).toBe(true);
  });

  it('rejects null, primitives, and objects without a string tool', () => {
    expect(isCsToolRequest(null)).toBe(false);
    expect(isCsToolRequest('string')).toBe(false);
    expect(isCsToolRequest({})).toBe(false);
    expect(isCsToolRequest({ tool: 42 })).toBe(false);
  });
});

describe('createCsDispatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('handleSwRequest posts a page-bridge request envelope to the window', () => {
    const { last } = captureLastPostedRequest();
    let nextId = 0;
    const dispatcher = createCsDispatcher({
      generateRequestId: () => `req-${++nextId}`,
    });

    dispatcher.handleSwRequest(
      { tool: 'session_ping', payload: { foo: 'bar' } },
      vi.fn(),
    );

    const env = last();
    expect(env).toBeDefined();
    expect(env?.ns).toBe(PAGE_BRIDGE_NS);
    expect(env?.dir).toBe('cs->page');
    expect(env?.tool).toBe('session_ping');
    expect(env?.requestId).toBe('req-1');
    expect(env?.payload).toEqual({ foo: 'bar' });
  });

  it('handlePageMessage resolves the matching pending request via sendResponse', () => {
    captureLastPostedRequest();
    const dispatcher = createCsDispatcher({
      generateRequestId: () => 'req-x',
    });
    const sendResponse = vi.fn();

    dispatcher.handleSwRequest({ tool: 'session_ping' }, sendResponse);
    dispatcher.handlePageMessage(
      makePageMessageEvent(
        encodeResponse({
          requestId: 'req-x',
          payload: { url: 'https://x', title: 't', readyState: 'complete' },
        }),
      ),
    );

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const arg = sendResponse.mock.calls[0]![0] as CsToolResponse;
    expect(arg.payload).toEqual({
      url: 'https://x',
      title: 't',
      readyState: 'complete',
    });
    expect(arg.error).toBeUndefined();
  });

  it('fires a timeout error after the configured budget', () => {
    captureLastPostedRequest();
    const dispatcher = createCsDispatcher({
      timeoutMs: 1000,
      generateRequestId: () => 'req-t',
    });
    const sendResponse = vi.fn();

    dispatcher.handleSwRequest({ tool: 'session_ping' }, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1001);

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const arg = sendResponse.mock.calls[0]![0] as CsToolResponse;
    expect(arg.error?.message).toMatch(/page-bridge timeout after 1000ms/);
    expect(arg.payload).toBeUndefined();
  });

  it('ignores a late reply that arrives after the timeout already fired', () => {
    captureLastPostedRequest();
    const dispatcher = createCsDispatcher({
      timeoutMs: 1000,
      generateRequestId: () => 'req-late',
    });
    const sendResponse = vi.fn();

    dispatcher.handleSwRequest({ tool: 'session_ping' }, sendResponse);
    vi.advanceTimersByTime(1001);
    expect(sendResponse).toHaveBeenCalledTimes(1);

    dispatcher.handlePageMessage(
      makePageMessageEvent(
        encodeResponse({ requestId: 'req-late', payload: { ok: true } }),
      ),
    );
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('dispose clears pending timers so they do not fire later', () => {
    captureLastPostedRequest();
    const dispatcher = createCsDispatcher({
      timeoutMs: 1000,
      generateRequestId: () => 'req-d',
    });
    const sendResponse = vi.fn();

    dispatcher.handleSwRequest({ tool: 'session_ping' }, sendResponse);
    dispatcher.dispose();
    vi.advanceTimersByTime(2000);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('forwards inbound page-event envelopes to the SW with the unwrapped event', () => {
    const forwarded: PageEventSwMessage[] = [];
    const dispatcher = createCsDispatcher({
      forwardEventToSw: (msg) => forwarded.push(msg),
    });
    const event = { kind: 'console', level: 'log', args: ['hi'] };
    dispatcher.handlePageMessage(makePageMessageEvent(encodeEvent(event)));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.tag).toBe(PAGE_EVENT_SW_TAG);
    expect(forwarded[0]?.event).toEqual(event);
  });

  it("does not cross page-event traffic with request/response correlation (sendResponse stays untouched)", () => {
    captureLastPostedRequest();
    const forwarded: PageEventSwMessage[] = [];
    const dispatcher = createCsDispatcher({
      generateRequestId: () => 'req-only',
      forwardEventToSw: (msg) => forwarded.push(msg),
    });
    const sendResponse = vi.fn();
    dispatcher.handleSwRequest({ tool: 'session_ping' }, sendResponse);
    // A page-event flows in BEFORE the response — must not satisfy the pending request.
    dispatcher.handlePageMessage(
      makePageMessageEvent(encodeEvent({ kind: 'console', level: 'log', args: [] })),
    );
    expect(sendResponse).not.toHaveBeenCalled();
    expect(forwarded).toHaveLength(1);
  });

  it('non-namespaced events are ignored (no forward, no response)', () => {
    const forwarded: PageEventSwMessage[] = [];
    const dispatcher = createCsDispatcher({
      forwardEventToSw: (msg) => forwarded.push(msg),
    });
    dispatcher.handlePageMessage(
      makePageMessageEvent({ ns: 'other', dir: 'page-event', event: {} }),
    );
    expect(forwarded).toHaveLength(0);
  });
});
