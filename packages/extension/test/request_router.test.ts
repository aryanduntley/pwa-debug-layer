import { describe, it, expect, vi } from 'vitest';
import {
  isSwRequestEnvelope,
  routeRequest,
  type RouterContext,
  type SwRequestEnvelope,
} from '../src/request_router.js';
import { createEventSink } from '../src/sw_event_sink/sw_event_sink.js';
import type {
  CapturedEvent,
  ConsoleCapturedEvent,
} from '../src/captures/types.js';

const makeCtx = (): RouterContext => ({ sink: createEventSink() });

const makeConsoleEvent = (
  ts: number,
  level: ConsoleCapturedEvent['level'] = 'log',
): ConsoleCapturedEvent => ({
  kind: 'console',
  level,
  args: [`event-${ts}`],
  ts,
  frameUrl: 'https://x',
  frameKey: 'top',
});

const makeForeignEvent = (kind: string, ts: number): CapturedEvent =>
  ({
    kind,
    ts,
    frameUrl: 'https://x',
    frameKey: 'top',
  }) as unknown as CapturedEvent;

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
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r1',
        tool: 'session_ping',
      },
      makeCtx(),
    );
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

  it("returns pageWorld:null + pageWorldError:'no_active_tab' (typed) when no active tab", async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    queryMock.mockResolvedValueOnce([]);
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r2',
        tool: 'session_ping',
      },
      makeCtx(),
    );
    const p = r.payload as {
      attachedTabId: number | null;
      pageWorld: unknown;
      pageWorldError?: string;
      pageWorldErrorMessage?: string;
    };
    expect(p.attachedTabId).toBeNull();
    expect(p.pageWorld).toBeNull();
    expect(p.pageWorldError).toBe('no_active_tab');
    expect(p.pageWorldErrorMessage).toBe('no active tab');
  });

  it('self-heals when sendMessage rejects but probe + reinject succeed (returns pageWorld + pageWorldSelfHealed:true)', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock
      .mockRejectedValueOnce(
        new Error(
          'Could not establish connection. Receiving end does not exist.',
        ),
      )
      .mockResolvedValueOnce({
        payload: {
          url: 'https://test.example/',
          title: 'Test Page',
          readyState: 'complete',
        },
      });
    // setup.ts default chrome.scripting.executeScript returns [{result:'__pwa_debug_probe__'}]
    // — probe returns scripts_run, then 2 inject calls also resolve via default mock.
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r3',
        tool: 'session_ping',
      },
      makeCtx(),
    );
    const p = r.payload as {
      attachedTabId: number | null;
      pageWorld: { url: string } | null;
      pageWorldError?: string;
      pageWorldSelfHealed?: boolean;
    };
    expect(p.attachedTabId).toBe(7);
    expect(p.pageWorld?.url).toBe('https://test.example/');
    expect(p.pageWorldError).toBeUndefined();
    expect(p.pageWorldSelfHealed).toBe(true);
  });

  it("returns typed code 'cs_not_attached_refresh_tab' when self-heal retry still fails", async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock
      .mockRejectedValueOnce(new Error('Could not establish connection.'))
      .mockRejectedValueOnce(new Error('Could not establish connection (retry).'));
    const r = await routeRequest(
      { type: 'request', requestId: 'r3b', tool: 'session_ping' },
      makeCtx(),
    );
    const p = r.payload as {
      pageWorld: unknown;
      pageWorldError?: string;
      pageWorldErrorMessage?: string;
      pageWorldSelfHealed?: boolean;
    };
    expect(p.pageWorld).toBeNull();
    expect(p.pageWorldError).toBe('cs_not_attached_refresh_tab');
    expect(p.pageWorldErrorMessage).toMatch(/retry/);
    expect(p.pageWorldSelfHealed).toBe(true);
  });

  it("returns typed code 'page_blocks_scripts' when probe throws after sendMessage rejects", async () => {
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(
      new Error('Could not establish connection.'),
    );
    vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(
      new Error('Cannot access contents of url'),
    );
    const r = await routeRequest(
      { type: 'request', requestId: 'r3c', tool: 'session_ping' },
      makeCtx(),
    );
    const p = r.payload as {
      pageWorld: unknown;
      pageWorldError?: string;
      pageWorldErrorMessage?: string;
    };
    expect(p.pageWorld).toBeNull();
    expect(p.pageWorldError).toBe('page_blocks_scripts');
    expect(p.pageWorldErrorMessage).toMatch(/Could not establish connection/);
  });

  it("returns typed code 'restricted_url' when sendMessage rejects on a chrome:// tab (no probe needed)", async () => {
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(
      new Error('Could not establish connection.'),
    );
    vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
      id: 7,
      url: 'chrome://extensions',
    } as chrome.tabs.Tab);
    const r = await routeRequest(
      { type: 'request', requestId: 'r3d', tool: 'session_ping' },
      makeCtx(),
    );
    const p = r.payload as {
      pageWorld: unknown;
      pageWorldError?: string;
    };
    expect(p.pageWorld).toBeNull();
    expect(p.pageWorldError).toBe('restricted_url');
  });

  it("returns typed code 'page_world_blocked' when CS reports an error envelope (page-bridge timeout)", async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      error: { message: 'page-bridge timeout after 4000ms (tool=session_ping)' },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r4',
        tool: 'session_ping',
      },
      makeCtx(),
    );
    const p = r.payload as {
      pageWorld: unknown;
      pageWorldError?: string;
      pageWorldErrorMessage?: string;
    };
    expect(p.pageWorld).toBeNull();
    expect(p.pageWorldError).toBe('page_world_blocked');
    expect(p.pageWorldErrorMessage).toMatch(/page-bridge timeout/);
  });
});

describe('routeRequest — recent_events', () => {
  it('returns events:[] + stats from the sink on an empty buffer', async () => {
    const ctx = makeCtx();
    const r = await routeRequest(
      { type: 'request', requestId: 'r10', tool: 'recent_events' },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(r.payload).toEqual({
      events: [],
      stats: { totalReceived: 0, perKind: {}, bufferSize: 200 },
    });
  });

  it('returns events seeded into the sink in oldest -> newest order', async () => {
    const ctx = makeCtx();
    ctx.sink.handle(makeConsoleEvent(1));
    ctx.sink.handle(makeConsoleEvent(2, 'warn'));
    ctx.sink.handle(makeConsoleEvent(3));
    const r = await routeRequest(
      { type: 'request', requestId: 'r11', tool: 'recent_events' },
      ctx,
    );
    const p = r.payload as {
      events: ReadonlyArray<{ ts: number; level?: string }>;
      stats: { totalReceived: number; perKind: Record<string, number> };
    };
    expect(p.events.map((e) => e.ts)).toEqual([1, 2, 3]);
    expect(p.stats.totalReceived).toBe(3);
    expect(p.stats.perKind['console']).toBe(3);
  });

  it('passes kinds + sinceMs + limit filters through to sink.getRecent', async () => {
    const ctx = makeCtx();
    [1, 2, 3, 4, 5].forEach((ts) => ctx.sink.handle(makeConsoleEvent(ts)));
    ctx.sink.handle(makeForeignEvent('fetch', 6));
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r12',
        tool: 'recent_events',
        payload: { kinds: ['console'], sinceMs: 2, limit: 2 },
      },
      ctx,
    );
    const p = r.payload as { events: ReadonlyArray<{ ts: number }> };
    expect(p.events.map((e) => e.ts)).toEqual([4, 5]);
  });

  it('sanitizes garbage payload fields (drops non-string kinds, ignores non-number sinceMs/limit)', async () => {
    const ctx = makeCtx();
    [1, 2, 3].forEach((ts) => ctx.sink.handle(makeConsoleEvent(ts)));
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r13',
        tool: 'recent_events',
        payload: {
          kinds: ['console', 42, null, 'xhr'],
          sinceMs: 'not-a-number',
          limit: { also: 'wrong' },
        },
      },
      ctx,
    );
    const p = r.payload as { events: ReadonlyArray<{ ts: number }> };
    expect(p.events.map((e) => e.ts)).toEqual([1, 2, 3]);
  });

  it('accepts undefined payload (defaults all filters)', async () => {
    const ctx = makeCtx();
    ctx.sink.handle(makeConsoleEvent(1));
    const r = await routeRequest(
      { type: 'request', requestId: 'r14', tool: 'recent_events' },
      ctx,
    );
    const p = r.payload as { events: ReadonlyArray<unknown> };
    expect(p.events.length).toBe(1);
  });
});

describe('routeRequest — evaluate', () => {
  it('routes via active tab when tab_id is absent and forwards page-world payload verbatim', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { value: 42, durationMs: 1 },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-eval-1',
        tool: 'evaluate',
        payload: { expression: '40+2' },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.payload).toEqual({ value: 42, durationMs: 1 });
    // Confirm active-tab path: chrome.tabs.query was used to resolve tabId
    expect(vi.mocked(chrome.tabs.query)).toHaveBeenCalled();
    const callArgs = sendMock.mock.calls.at(-1);
    expect(callArgs?.[0]).toBe(7);
    expect(callArgs?.[1]).toMatchObject({
      tool: 'evaluate',
      payload: { expression: '40+2' },
    });
  });

  it('routes to a specific tab when payload.tab_id is provided (skips active-tab lookup)', async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    const queryCallsBefore = queryMock.mock.calls.length;
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { value: 'tab-99', durationMs: 2 },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-eval-2',
        tool: 'evaluate',
        payload: {
          expression: 'document.title',
          tab_id: 99,
          await_promise: true,
          timeout_ms: 1000,
        },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.payload).toEqual({ value: 'tab-99', durationMs: 2 });
    // No active-tab lookup when tab_id is provided
    expect(queryMock.mock.calls.length).toBe(queryCallsBefore);
    const callArgs = sendMock.mock.calls.at(-1);
    expect(callArgs?.[0]).toBe(99);
    expect(callArgs?.[1]).toMatchObject({
      tool: 'evaluate',
      payload: {
        expression: 'document.title',
        await_promise: true,
        timeout_ms: 1000,
      },
    });
  });

  it('returns an error envelope when no active tab is present', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([]);
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-eval-3',
        tool: 'evaluate',
        payload: { expression: '1+1' },
      },
      makeCtx(),
    );
    expect(r.payload).toBeUndefined();
    expect(r.error?.message).toBe('no active tab');
  });

  it('surfaces a CS-side page-bridge error.message into the SW error envelope', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
      error: { message: 'page-bridge timeout after 4000ms (tool=evaluate)' },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-eval-4',
        tool: 'evaluate',
        payload: { expression: '1+1' },
      },
      makeCtx(),
    );
    expect(r.payload).toBeUndefined();
    expect(r.error?.message).toMatch(/page-bridge timeout/);
  });

  it('rejects malformed payload (no expression) with a descriptive error envelope', async () => {
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-eval-5',
        tool: 'evaluate',
        payload: { tab_id: 7 },
      },
      makeCtx(),
    );
    expect(r.payload).toBeUndefined();
    expect(r.error?.message).toMatch(/payload must be/);
  });
});

describe('routeRequest — react_tree', () => {
  it('routes via active tab when tab_id is absent and forwards page-world payload verbatim', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { roots: [], truncated: false, rootCount: 0 },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-rt-1',
        tool: 'react_tree',
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.payload).toEqual({ roots: [], truncated: false, rootCount: 0 });
    expect(vi.mocked(chrome.tabs.query)).toHaveBeenCalled();
    const callArgs = sendMock.mock.calls.at(-1);
    expect(callArgs?.[0]).toBe(7);
    expect(callArgs?.[1]).toMatchObject({
      tool: 'react_tree',
      payload: {},
    });
  });

  it('routes to a specific tab when payload.tab_id is provided and forwards options verbatim', async () => {
    const queryMock = vi.mocked(chrome.tabs.query);
    const queryCallsBefore = queryMock.mock.calls.length;
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { roots: [], truncated: true, rootCount: 1 },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-rt-2',
        tool: 'react_tree',
        payload: {
          tab_id: 99,
          root_index: 0,
          depth_limit: 4,
          max_nodes: 50,
        },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    expect(r.payload).toEqual({ roots: [], truncated: true, rootCount: 1 });
    expect(queryMock.mock.calls.length).toBe(queryCallsBefore);
    const callArgs = sendMock.mock.calls.at(-1);
    expect(callArgs?.[0]).toBe(99);
    expect(callArgs?.[1]).toMatchObject({
      tool: 'react_tree',
      payload: {
        root_index: 0,
        depth_limit: 4,
        max_nodes: 50,
      },
    });
  });

  it('returns an error envelope when no active tab is present', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([]);
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-rt-3',
        tool: 'react_tree',
      },
      makeCtx(),
    );
    expect(r.payload).toBeUndefined();
    expect(r.error?.message).toBe('no active tab');
  });

  it('surfaces a CS-side page-bridge error.message into the SW error envelope', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
      error: { message: 'page-bridge timeout after 4000ms (tool=react_tree)' },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-rt-4',
        tool: 'react_tree',
      },
      makeCtx(),
    );
    expect(r.payload).toBeUndefined();
    expect(r.error?.message).toMatch(/page-bridge timeout/);
  });

  it('drops malformed numeric fields silently and forwards only well-formed ones', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { roots: [], truncated: false, rootCount: 0 },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-rt-5',
        tool: 'react_tree',
        payload: {
          root_index: -1,
          depth_limit: 0,
          max_nodes: 'not a number',
        },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    const callArgs = sendMock.mock.calls.at(-1);
    expect(callArgs?.[1]).toMatchObject({
      tool: 'react_tree',
      payload: {},
    });
  });
});

describe('routeRequest — react_get_state', () => {
  it('routes via active tab and forwards stable_id payload', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { stableId: 'root0/App[0]', displayName: 'App' },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-gs-1',
        tool: 'react_get_state',
        payload: { stable_id: 'root0/App[0]' },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    const callArgs = sendMock.mock.calls.at(-1);
    expect(callArgs?.[0]).toBe(7);
    expect(callArgs?.[1]).toMatchObject({
      tool: 'react_get_state',
      payload: { stable_id: 'root0/App[0]' },
    });
  });

  it('routes to a specific tab_id and forwards all options', async () => {
    const sendMock = vi.mocked(chrome.tabs.sendMessage);
    sendMock.mockResolvedValueOnce({
      payload: { stableId: 'root0/App[0]', displayName: 'App' },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-gs-2',
        tool: 'react_get_state',
        payload: {
          tab_id: 42,
          stable_id: 'root0/App[0]/Counter[0]',
          root_index: 0,
          include_props: true,
          include_hooks: false,
        },
      },
      makeCtx(),
    );
    expect(r.error).toBeUndefined();
    const callArgs = sendMock.mock.calls.at(-1);
    expect(callArgs?.[0]).toBe(42);
    expect(callArgs?.[1]).toMatchObject({
      tool: 'react_get_state',
      payload: {
        stable_id: 'root0/App[0]/Counter[0]',
        root_index: 0,
        include_props: true,
        include_hooks: false,
      },
    });
  });

  it('rejects payloads missing stable_id', async () => {
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-gs-3',
        tool: 'react_get_state',
        payload: { tab_id: 7 },
      },
      makeCtx(),
    );
    expect(r.payload).toBeUndefined();
    expect(r.error?.message).toMatch(/stable_id: non-empty string/);
  });

  it('rejects payloads with empty stable_id', async () => {
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-gs-4',
        tool: 'react_get_state',
        payload: { stable_id: '' },
      },
      makeCtx(),
    );
    expect(r.payload).toBeUndefined();
    expect(r.error?.message).toMatch(/stable_id/);
  });

  it('surfaces a CS-side page-bridge error.message', async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce({
      error: { message: 'page-bridge timeout after 4000ms (tool=react_get_state)' },
    });
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r-gs-5',
        tool: 'react_get_state',
        payload: { stable_id: 'root0' },
      },
      makeCtx(),
    );
    expect(r.payload).toBeUndefined();
    expect(r.error?.message).toMatch(/page-bridge timeout/);
  });
});

describe('routeRequest — error paths', () => {
  it('returns an error envelope for an unknown tool', async () => {
    const r = await routeRequest(
      {
        type: 'request',
        requestId: 'r5',
        tool: 'no_such_tool',
      },
      makeCtx(),
    );
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
    const r = await routeRequest(env, makeCtx());
    expect(r.error?.message).toMatch(/tabs api failed/);
    expect(r.payload).toBeUndefined();
  });
});
