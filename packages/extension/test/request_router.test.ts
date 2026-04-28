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

describe('routeRequest', () => {
  it('returns extensionVersion + attachedTabId for session_ping', async () => {
    const env: SwRequestEnvelope = {
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    };
    const r = await routeRequest(env);
    expect(r.type).toBe('response');
    expect(r.requestId).toBe('r1');
    expect(r.error).toBeUndefined();
    expect(r.payload).toEqual({
      extensionVersion: '0.0.0-test',
      attachedTabId: 7,
    });
  });

  it('returns attachedTabId:null when chrome.tabs.query yields no tab', async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    queryMock.mockResolvedValueOnce([]);
    const r = await routeRequest({
      type: 'request',
      requestId: 'r2',
      tool: 'session_ping',
    });
    expect(r.payload).toEqual({
      extensionVersion: '0.0.0-test',
      attachedTabId: null,
    });
  });

  it('returns an error envelope for an unknown tool', async () => {
    const r = await routeRequest({
      type: 'request',
      requestId: 'r3',
      tool: 'no_such_tool',
    });
    expect(r.error?.message).toMatch(/unknown tool: no_such_tool/);
    expect(r.payload).toBeUndefined();
    expect(r.requestId).toBe('r3');
  });

  it('catches handler exceptions and returns an error envelope', async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    queryMock.mockRejectedValueOnce(new Error('tabs api failed'));
    const r = await routeRequest({
      type: 'request',
      requestId: 'r4',
      tool: 'session_ping',
    });
    expect(r.error?.message).toMatch(/tabs api failed/);
    expect(r.payload).toBeUndefined();
  });
});
