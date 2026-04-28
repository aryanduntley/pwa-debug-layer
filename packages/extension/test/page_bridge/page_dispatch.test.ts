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
