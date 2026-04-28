import { describe, it, expect, vi } from 'vitest';
import {
  isSwRequestEnvelope,
  routeRequest,
  type SwRequestEnvelope,
} from '../src/request_router.js';

describe('isSwRequestEnvelope', () => {
  it('accepts a valid request envelope', () => {
    expect(
      isSwRequestEnvelope({
        type: 'request',
        requestId: 'r1',
        tool: 'session_ping',
      }),
    ).toBe(true);
  });

  it('rejects null and non-objects', () => {
    expect(isSwRequestEnvelope(null)).toBe(false);
    expect(isSwRequestEnvelope('string')).toBe(false);
    expect(isSwRequestEnvelope(42)).toBe(false);
    expect(isSwRequestEnvelope(undefined)).toBe(false);
  });

  it('rejects envelopes with the wrong type discriminator', () => {
    expect(
      isSwRequestEnvelope({
        type: 'response',
        requestId: 'r1',
        tool: 'session_ping',
      }),
    ).toBe(false);
    expect(
      isSwRequestEnvelope({ type: 'event', requestId: 'r1', tool: 'x' }),
    ).toBe(false);
  });

  it('rejects envelopes missing requestId or tool', () => {
    expect(isSwRequestEnvelope({ type: 'request', tool: 't' })).toBe(false);
    expect(isSwRequestEnvelope({ type: 'request', requestId: 'r1' })).toBe(
      false,
    );
    expect(
      isSwRequestEnvelope({ type: 'request', requestId: 1, tool: 't' }),
    ).toBe(false);
  });
});

describe('routeRequest — session_ping', () => {
  it('returns extensionVersion + attachedTabId + pageWorld on the happy path', async () => {
    const r = await routeRequest({
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    });
    expect(r.type).toBe('response');
    expect(r.requestId).toBe('r1');
    expect(r.error).toBeUndefined();
    expect(r.payload).toEqual({
      extensionVersion: '0.0.0-test',
      attachedTabId: 7,
      pageWorld: {
        url: 'https://test.example/',
        title: 'Test Page',
        readyState: 'complete',
      },
    });
  });

  it('returns pageWorld:null + pageWorldError when no active tab', async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    queryMock.mockResolvedValueOnce([]);
    const r = await routeRequest({
      type: 'request',
      requestId: 'r2',
      tool: 'session_ping',
    });
    const p = r.payload as {
      attachedTabId: number | null;
      pageWorld: unknown;
      pageWorldError?: string;
    };
    expect(p.attachedTabId).toBeNull();
    expect(p.pageWorld).toBeNull();
    expect(p.pageWorldError).toBe('no active tab');
  });

  it('returns pageWorld:null + pageWorldError when chrome.tabs.sendMessage rejects', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );
    const r = await routeRequest({
      type: 'request',
      requestId: 'r3',
      tool: 'session_ping',
    });
    const p = r.payload as {
      attachedTabId: number | null;
      pageWorld: unknown;
      pageWorldError?: string;
    };
    expect(p.attachedTabId).toBe(7);
    expect(p.pageWorld).toBeNull();
    expect(p.pageWorldError).toMatch(/Could not establish connection/);
  });

  it('returns pageWorld:null + pageWorldError when CS reports an error', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      error: { message: 'page-bridge timeout after 4000ms (tool=session_ping)' },
    });
    const r = await routeRequest({
      type: 'request',
      requestId: 'r4',
      tool: 'session_ping',
    });
    const p = r.payload as {
      pageWorld: unknown;
      pageWorldError?: string;
    };
    expect(p.pageWorld).toBeNull();
    expect(p.pageWorldError).toMatch(/page-bridge timeout/);
  });
});

describe('routeRequest — error paths', () => {
  it('returns an error envelope for an unknown tool', async () => {
    const r = await routeRequest({
      type: 'request',
      requestId: 'r5',
      tool: 'no_such_tool',
    });
    expect(r.error?.message).toMatch(/unknown tool: no_such_tool/);
    expect(r.payload).toBeUndefined();
    expect(r.requestId).toBe('r5');
  });

  it('catches handler exceptions and returns an error envelope', async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    queryMock.mockRejectedValueOnce(new Error('tabs api failed'));
    const env: SwRequestEnvelope = {
      type: 'request',
      requestId: 'r6',
      tool: 'session_ping',
    };
    const r = await routeRequest(env);
    expect(r.error?.message).toMatch(/tabs api failed/);
    expect(r.payload).toBeUndefined();
  });
});
