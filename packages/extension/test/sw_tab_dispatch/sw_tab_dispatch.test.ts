import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatchToTab,
  dispatchToActiveTab,
} from '../../src/sw_tab_dispatch/sw_tab_dispatch.js';

describe('dispatchToTab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves with the response from chrome.tabs.sendMessage', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { url: 'https://x', title: 't', readyState: 'complete' },
    });
    const promise = dispatchToTab(7, { tool: 'session_ping' });
    await vi.advanceTimersByTimeAsync(0);
    const r = await promise;
    expect(r.payload).toEqual({
      url: 'https://x',
      title: 't',
      readyState: 'complete',
    });
    expect(sendMock).toHaveBeenCalledWith(7, { tool: 'session_ping' });
  });

  it('rejects with the sendMessage error', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockRejectedValueOnce(new Error('Could not establish connection'));
    await expect(
      dispatchToTab(7, { tool: 'session_ping' }),
    ).rejects.toThrow(/Could not establish connection/);
  });

  it('rejects with a timeout error when sendMessage hangs', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockImplementationOnce(() => new Promise(() => {}));
    const promise = dispatchToTab(
      7,
      { tool: 'session_ping' },
      { timeoutMs: 200 },
    );
    const assertion = expect(promise).rejects.toThrow(
      /sw-tab-dispatch timeout after 200ms \(tabId=7\)/,
    );
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });
});

describe('dispatchToActiveTab', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries the active tab and dispatches to it', async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    queryMock.mockResolvedValueOnce([
      { id: 99, active: true } as chrome.tabs.Tab,
    ]);
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({ payload: { ok: true } });

    const r = await dispatchToActiveTab({ tool: 'session_ping' });
    expect(r.payload).toEqual({ ok: true });
    expect(sendMock).toHaveBeenCalledWith(99, { tool: 'session_ping' });
  });

  it('throws "no active tab" when chrome.tabs.query returns nothing', async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    queryMock.mockResolvedValueOnce([]);
    await expect(
      dispatchToActiveTab({ tool: 'session_ping' }),
    ).rejects.toThrow(/no active tab/);
  });
});
