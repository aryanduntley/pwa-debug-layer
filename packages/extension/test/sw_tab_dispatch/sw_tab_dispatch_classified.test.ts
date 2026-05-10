import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  dispatchToTabClassified,
  dispatchToActiveTabClassified,
} from '../../src/sw_tab_dispatch/sw_tab_dispatch.js';

describe('dispatchToTabClassified', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true with response on the happy path (no probe / no inject)', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
      payload: { url: 'https://x', title: 't', readyState: 'complete' },
    });
    const exec = vi.mocked(chrome.scripting.executeScript);
    const callsBefore = exec.mock.calls.length;
    const r = await dispatchToTabClassified(7, { tool: 'session_ping' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.payload).toEqual({
        url: 'https://x',
        title: 't',
        readyState: 'complete',
      });
      expect(r.selfHealed).toBeUndefined();
    }
    expect(exec.mock.calls.length).toBe(callsBefore);
  });

  it('returns code:restricted_url when sendMessage fails on a chrome:// tab (short-circuits probe)', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
      id: 7,
      url: 'chrome://extensions',
    } as chrome.tabs.Tab);
    const exec = vi.mocked(chrome.scripting.executeScript);
    const callsBefore = exec.mock.calls.length;
    const r = await dispatchToTabClassified(7, { tool: 'session_ping' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('restricted_url');
    // No probe attempted because URL classified first
    expect(exec.mock.calls.length).toBe(callsBefore);
  });

  it('returns code:page_blocks_scripts when sendMessage fails and probe throws', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
      id: 7,
      url: 'https://chainsale.app/',
    } as chrome.tabs.Tab);
    vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(
      new Error('Cannot access contents of url'),
    );
    const r = await dispatchToTabClassified(7, { tool: 'session_ping' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('page_blocks_scripts');
      expect(r.message).toMatch(/Could not establish connection/);
      expect(r.selfHealed).toBeUndefined();
    }
  });

  it('self-heals when probe succeeds: injects, retries, returns ok:true with selfHealed:true', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock
      .mockRejectedValueOnce(
        new Error('Could not establish connection. Receiving end does not exist.'),
      )
      .mockResolvedValueOnce({
        payload: { url: 'https://chainsale.app/', title: 'CS', readyState: 'complete' },
      });
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
      id: 7,
      url: 'https://chainsale.app/',
    } as chrome.tabs.Tab);
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec
      .mockResolvedValueOnce([{ result: '__pwa_debug_probe__' } as never]) // probe ok
      .mockResolvedValueOnce([] as never) // inject ISOLATED
      .mockResolvedValueOnce([] as never); // inject MAIN

    const r = await dispatchToTabClassified(7, { tool: 'session_ping' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.selfHealed).toBe(true);
      expect((r.response.payload as { title: string }).title).toBe('CS');
    }
    expect(sendMock).toHaveBeenCalledTimes(2);
    // 1 probe + 2 inject calls
    const totalScriptingCalls = exec.mock.calls.length;
    expect(totalScriptingCalls).toBeGreaterThanOrEqual(3);
  });

  it('returns code:cs_not_attached_refresh_tab + selfHealed:true when retry sendMessage still fails', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock
      .mockRejectedValueOnce(new Error('Could not establish connection.'))
      .mockRejectedValueOnce(new Error('Could not establish connection (retry).'));
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
      id: 7,
      url: 'https://chainsale.app/',
    } as chrome.tabs.Tab);
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec
      .mockResolvedValueOnce([{ result: '__pwa_debug_probe__' } as never])
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);
    const r = await dispatchToTabClassified(7, { tool: 'session_ping' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('cs_not_attached_refresh_tab');
      expect(r.selfHealed).toBe(true);
      expect(r.message).toMatch(/retry/);
    }
  });

  it('returns code:cs_inject_failed when self-heal injection throws', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(
      new Error('Could not establish connection.'),
    );
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
      id: 7,
      url: 'https://chainsale.app/',
    } as chrome.tabs.Tab);
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec
      .mockResolvedValueOnce([{ result: '__pwa_debug_probe__' } as never]) // probe ok
      .mockRejectedValueOnce(new Error('No tab with id 7')); // inject fails
    const r = await dispatchToTabClassified(7, { tool: 'session_ping' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('cs_inject_failed');
      expect(r.selfHealed).toBe(true);
      expect(r.message).toMatch(/No tab with id 7/);
    }
  });

  it('returns code:page_world_blocked when sendMessage succeeds but response carries an error envelope', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
      error: { message: 'page-bridge timeout after 4000ms (tool=session_ping)' },
    });
    const r = await dispatchToTabClassified(7, { tool: 'session_ping' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('page_world_blocked');
      expect(r.message).toMatch(/page-bridge timeout/);
    }
  });
});

describe('dispatchToActiveTabClassified', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns code:no_active_tab when chrome.tabs.query returns nothing', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([]);
    const r = await dispatchToActiveTabClassified({ tool: 'session_ping' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('no_active_tab');
      expect(r.message).toBe('no active tab');
    }
  });

  it('delegates to dispatchToTabClassified on the active tab on the happy path', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
      { id: 99, active: true, url: 'https://x' } as chrome.tabs.Tab,
    ]);
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
      payload: { ok: true },
    });
    const r = await dispatchToActiveTabClassified({ tool: 'session_ping' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.response.payload).toEqual({ ok: true });
    expect(vi.mocked(chrome.tabs.sendMessage)).toHaveBeenCalledWith(99, {
      tool: 'session_ping',
    });
  });
});
