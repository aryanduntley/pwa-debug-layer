import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  normalizeUrl,
  navigateTab,
  openNewTab,
} from '../../src/sw_navigation/sw_navigation.js';
import { routeRequest } from '../../src/request_router.js';
import { createEventSink } from '../../src/sw_event_sink/sw_event_sink.js';

// A chrome.tabs stub with a working onUpdated emitter. `complete` controls whether
// a navigation eventually reports document 'complete' (fired on a real timer so it
// lands AFTER waitForComplete has registered its listener).
const makeNavChrome = (opts: {
  complete: boolean;
  activeTabId?: number;
  createId?: number;
}) => {
  const listeners = new Set<(id: number, info: { status?: string }) => void>();
  const emitComplete = (id: number): void => {
    if (!opts.complete) return;
    setTimeout(() => listeners.forEach((l) => l(id, { status: 'complete' })), 0);
  };
  return {
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue(
          opts.activeTabId !== undefined ? [{ id: opts.activeTabId }] : [],
        ),
      update: vi.fn(async (tabId: number) => {
        emitComplete(tabId);
        return { id: tabId, windowId: 1 };
      }),
      create: vi.fn(async () => {
        const id = opts.createId ?? 99;
        emitComplete(id);
        return { id, windowId: 2 };
      }),
      onUpdated: {
        addListener: (l: (id: number, info: { status?: string }) => void) =>
          listeners.add(l),
        removeListener: (l: (id: number, info: { status?: string }) => void) =>
          listeners.delete(l),
      },
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeUrl', () => {
  it('assumes https:// when no scheme is given', () => {
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
  });

  it('preserves an explicit scheme', () => {
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(normalizeUrl('chrome://extensions')).toBe('chrome://extensions');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUrl('  https://x.dev  ')).toBe('https://x.dev');
  });

  it('rejects empty / whitespace-only input', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('rejects javascript: URLs', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('  JavaScript:void(0)')).toBeNull();
  });
});

describe('navigateTab', () => {
  it('navigates the active tab and reports complete', async () => {
    const chrome = makeNavChrome({ complete: true, activeTabId: 7 });
    vi.stubGlobal('chrome', chrome);
    const result = await navigateTab({ url: 'example.com' });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, {
      url: 'https://example.com',
    });
    expect(result).toEqual({
      tabId: 7,
      url: 'https://example.com',
      windowId: 1,
      status: 'complete',
    });
  });

  it('uses an explicit tab_id when given', async () => {
    const chrome = makeNavChrome({ complete: true });
    vi.stubGlobal('chrome', chrome);
    const result = await navigateTab({ tabId: 42, url: 'https://x.dev' });
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { url: 'https://x.dev' });
    expect(result.tabId).toBe(42);
  });

  it("returns status 'loading' when the load does not complete before timeout", async () => {
    vi.stubGlobal('chrome', makeNavChrome({ complete: false, activeTabId: 7 }));
    const result = await navigateTab({ url: 'https://slow.dev', timeoutMs: 20 });
    expect(result.status).toBe('loading');
  });

  it('throws when there is no active tab and no tab_id', async () => {
    vi.stubGlobal('chrome', makeNavChrome({ complete: true }));
    await expect(navigateTab({ url: 'https://x.dev' })).rejects.toThrow(
      /no active tab/,
    );
  });

  it('throws on an invalid url', async () => {
    vi.stubGlobal('chrome', makeNavChrome({ complete: true, activeTabId: 7 }));
    await expect(
      navigateTab({ url: 'javascript:alert(1)' }),
    ).rejects.toThrow(/invalid or unsupported url/);
  });
});

describe('openNewTab', () => {
  it('creates a tab and reports created:true + complete', async () => {
    const chrome = makeNavChrome({ complete: true, createId: 99 });
    vi.stubGlobal('chrome', chrome);
    const result = await openNewTab({ url: 'example.com', active: false });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com',
      active: false,
    });
    expect(result).toEqual({
      tabId: 99,
      url: 'https://example.com',
      windowId: 2,
      status: 'complete',
      created: true,
    });
  });

  it('throws on an invalid url', async () => {
    vi.stubGlobal('chrome', makeNavChrome({ complete: true }));
    await expect(openNewTab({ url: '' })).rejects.toThrow(
      /invalid or unsupported url/,
    );
  });
});

describe('routeRequest — navigation', () => {
  const ctx = { sink: createEventSink() };

  it('routes pdl_navigate to the handler and returns the nav result', async () => {
    vi.stubGlobal('chrome', makeNavChrome({ complete: true, activeTabId: 7 }));
    const r = await routeRequest(
      { type: 'request', requestId: 'n1', tool: 'pdl_navigate', payload: { url: 'x.dev' } },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(r.payload).toMatchObject({ tabId: 7, url: 'https://x.dev', status: 'complete' });
  });

  it('errors when pdl_navigate is missing a url', async () => {
    vi.stubGlobal('chrome', makeNavChrome({ complete: true, activeTabId: 7 }));
    const r = await routeRequest(
      { type: 'request', requestId: 'n2', tool: 'pdl_navigate', payload: {} },
      ctx,
    );
    expect(r.error?.message).toMatch(/url: non-empty string/);
  });

  it('routes pdl_new_tab to the handler', async () => {
    vi.stubGlobal('chrome', makeNavChrome({ complete: true, createId: 12 }));
    const r = await routeRequest(
      { type: 'request', requestId: 'n3', tool: 'pdl_new_tab', payload: { url: 'https://y.dev' } },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(r.payload).toMatchObject({ tabId: 12, url: 'https://y.dev', created: true });
  });
});
