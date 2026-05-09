import { describe, it, expect, beforeEach } from 'vitest';
import {
  sessionPingHandler,
  dispatchPageRequest,
} from '../../src/page_bridge/page_dispatch.js';
import {
  PAGE_BRIDGE_NS,
  type PageBridgeRequestEnvelope,
} from '../../src/page_bridge/protocol.js';

const makeRequest = (
  tool: string,
  requestId = 'r1',
): PageBridgeRequestEnvelope =>
  Object.freeze({
    ns: PAGE_BRIDGE_NS,
    dir: 'cs->page' as const,
    requestId,
    tool,
  });

describe('sessionPingHandler', () => {
  beforeEach(() => {
    document.title = 'Page Dispatch Test';
  });

  it('reads ambient location/title/readyState into a frozen payload', () => {
    const out = sessionPingHandler();
    expect(out.url).toBe(window.location.href);
    expect(out.title).toBe('Page Dispatch Test');
    expect(['loading', 'interactive', 'complete']).toContain(out.readyState);
    expect(Object.isFrozen(out)).toBe(true);
  });
});

describe('dispatchPageRequest', () => {
  it('routes session_ping to the handler and wraps the result', async () => {
    const env = await dispatchPageRequest(makeRequest('session_ping'));
    expect(env.dir).toBe('page->cs');
    expect(env.requestId).toBe('r1');
    expect(env.error).toBeUndefined();
    expect(env.payload).toMatchObject({
      url: expect.any(String),
      title: expect.any(String),
      readyState: expect.any(String),
    });
  });

  it('returns an error envelope for an unknown tool (never throws)', async () => {
    const env = await dispatchPageRequest(makeRequest('no_such_tool', 'r2'));
    expect(env.requestId).toBe('r2');
    expect(env.payload).toBeUndefined();
    expect(env.error?.message).toMatch(/unknown tool: no_such_tool/);
  });
});

describe('dispatchPageRequest — multi-tool coexistence', () => {
  it('routes session_ping and evaluate concurrently with distinct requestIds and no cross-talk', async () => {
    const ping = dispatchPageRequest(makeRequest('session_ping', 'r-ping'));
    const evalA = dispatchPageRequest(
      Object.freeze({
        ns: PAGE_BRIDGE_NS,
        dir: 'cs->page' as const,
        requestId: 'r-eval-a',
        tool: 'evaluate',
        payload: { expression: '7*6' },
      }),
    );
    const evalB = dispatchPageRequest(
      Object.freeze({
        ns: PAGE_BRIDGE_NS,
        dir: 'cs->page' as const,
        requestId: 'r-eval-b',
        tool: 'evaluate',
        payload: { expression: '"hello"' },
      }),
    );
    const [pingResp, evalAResp, evalBResp] = await Promise.all([
      ping,
      evalA,
      evalB,
    ]);

    // requestIds preserved per-call
    expect(pingResp.requestId).toBe('r-ping');
    expect(evalAResp.requestId).toBe('r-eval-a');
    expect(evalBResp.requestId).toBe('r-eval-b');

    // session_ping routed to its handler
    expect(pingResp.payload).toMatchObject({
      url: expect.any(String),
      title: expect.any(String),
      readyState: expect.any(String),
    });
    // session_ping payload does NOT carry an evaluate-shaped value/durationMs field
    expect((pingResp.payload as Record<string, unknown>)['durationMs']).toBeUndefined();

    // evaluate calls routed to evaluateHandler (each carries its own value)
    const a = evalAResp.payload as { value: unknown; durationMs: number };
    const b = evalBResp.payload as { value: unknown; durationMs: number };
    expect(a.value).toBe(42);
    expect(b.value).toBe('hello');
    expect(typeof a.durationMs).toBe('number');
    expect(typeof b.durationMs).toBe('number');
  });

  it('an evaluate request does not regress the session_ping handler', async () => {
    // Run an evaluate first, then session_ping — assert ping output unchanged
    await dispatchPageRequest(
      Object.freeze({
        ns: PAGE_BRIDGE_NS,
        dir: 'cs->page' as const,
        requestId: 'r-eval-pre',
        tool: 'evaluate',
        payload: { expression: '1+1' },
      }),
    );
    const ping = await dispatchPageRequest(makeRequest('session_ping', 'r-ping-2'));
    expect(ping.requestId).toBe('r-ping-2');
    expect(ping.error).toBeUndefined();
    expect(ping.payload).toMatchObject({
      url: window.location.href,
      readyState: expect.stringMatching(/loading|interactive|complete/),
    });
  });
});
