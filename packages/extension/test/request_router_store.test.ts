import { describe, it, expect, vi } from 'vitest';
import {
  routeRequest,
  type RouterContext,
} from '../src/request_router.js';
import { createEventSink } from '../src/sw_event_sink/sw_event_sink.js';

const makeCtx = (): RouterContext => ({ sink: createEventSink() });

describe('routeRequest — unified store_* family (M2)', () => {
  it('store_get_state forwards a store_get_state csReq and passes framework through', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { framework: 'redux', state: { a: 1 }, scopeUrl: 'https://x/' },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 's-gs-1',
        tool: 'store_get_state',
        payload: { path: 'a', framework: 'redux' },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.payload).toMatchObject({ framework: 'redux', state: { a: 1 } });
    const csReq = sendMock.mock.calls.at(-1)?.[1];
    expect(csReq).toMatchObject({
      tool: 'store_get_state',
      payload: { path: 'a', framework: 'redux' },
    });
  });

  it('store_get_state omits framework from the wire payload when not supplied', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({ payload: { framework: 'redux', state: 0 } });
    await routeRequest(
      { type: 'request', requestId: 's-gs-2', tool: 'store_get_state', payload: {} },
      makeCtx(),
    );
    expect(sendMock.mock.calls.at(-1)?.[1]).toMatchObject({
      tool: 'store_get_state',
      payload: {},
    });
    expect(
      (sendMock.mock.calls.at(-1)?.[1] as { payload: Record<string, unknown> })
        .payload,
    ).not.toHaveProperty('framework');
  });

  it('store_subscribe forwards action + framework', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { active: true, framework: 'redux', scopeUrl: 'https://x/' },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 's-sub-1',
        tool: 'store_subscribe',
        payload: { action: 'start', framework: 'redux' },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    expect(sendMock.mock.calls.at(-1)?.[1]).toMatchObject({
      tool: 'store_subscribe',
      payload: { action: 'start', framework: 'redux' },
    });
  });

  it('store_dispatch forwards the action + framework', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { dispatched: true, framework: 'redux', action: { type: 'inc' } },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 's-disp-1',
        tool: 'store_dispatch',
        payload: { action: { type: 'inc' }, framework: 'redux' },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    expect(sendMock.mock.calls.at(-1)?.[1]).toMatchObject({
      tool: 'store_dispatch',
      payload: { action: { type: 'inc' }, framework: 'redux' },
    });
  });

  it('store_subscribe with a bad action is rejected before any dispatch', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockClear();
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 's-sub-bad',
        tool: 'store_subscribe',
        payload: { action: 'nope' },
      },
      makeCtx(),
    );
    expect(r.error?.message).toMatch(/store_subscribe/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
