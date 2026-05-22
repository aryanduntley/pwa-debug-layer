import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dispatchPageRequest } from '../../src/page_bridge/page_dispatch.js';
import {
  PAGE_BRIDGE_NS,
  type PageBridgeRequestEnvelope,
} from '../../src/page_bridge/protocol.js';

const makeRequest = (
  tool: string,
  payload?: unknown,
  requestId = 'r1',
): PageBridgeRequestEnvelope =>
  Object.freeze({
    ns: PAGE_BRIDGE_NS,
    dir: 'cs->page' as const,
    requestId,
    tool,
    ...(payload !== undefined ? { payload } : {}),
  });

type FakeStore = {
  state: Record<string, unknown>;
  listeners: Set<() => void>;
  getState: () => Record<string, unknown>;
  subscribe: (l: () => void) => () => void;
  dispatch: (a: { type: string }) => unknown;
  setState: (next: Record<string, unknown>) => void;
};

const makeStore = (initial: Record<string, unknown>): FakeStore => {
  const store: FakeStore = {
    state: initial,
    listeners: new Set(),
    getState: () => store.state,
    subscribe: (l) => {
      store.listeners.add(l);
      return () => store.listeners.delete(l);
    },
    dispatch: vi.fn((a: { type: string }) => a),
    setState: (next) => {
      store.state = next;
      for (const l of store.listeners) l();
    },
  };
  return store;
};

const scope = window as unknown as { __pwaDebug_redux?: unknown };

describe('page_dispatch — unified store_* family (M2)', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = makeStore({ counter: { value: 1 } });
    scope.__pwaDebug_redux = store;
  });

  afterEach(async () => {
    // Tear down any active subscription so the module singleton does not leak.
    await dispatchPageRequest(makeRequest('store_subscribe', { action: 'stop' }));
    delete scope.__pwaDebug_redux;
    vi.restoreAllMocks();
  });

  it('store_get_state returns the framework tag plus state', async () => {
    const env = await dispatchPageRequest(makeRequest('store_get_state', {}));
    expect(env.error).toBeUndefined();
    const p = env.payload as { framework: string; state: unknown };
    expect(p.framework).toBe('redux');
    expect(p.state).toEqual({ counter: { value: 1 } });
  });

  it('store_get_state narrows by path and echoes it', async () => {
    const env = await dispatchPageRequest(
      makeRequest('store_get_state', { path: 'counter.value' }),
    );
    const p = env.payload as { framework: string; state: unknown; path: string };
    expect(p.framework).toBe('redux');
    expect(p.state).toBe(1);
    expect(p.path).toBe('counter.value');
  });

  it('redux_get_state alias still works and also reports framework', async () => {
    const env = await dispatchPageRequest(makeRequest('redux_get_state', {}));
    const p = env.payload as { framework: string; state: unknown };
    expect(p.framework).toBe('redux');
    expect(p.state).toEqual({ counter: { value: 1 } });
  });

  it('an explicit unknown framework selector yields a no-store error', async () => {
    const env = await dispatchPageRequest(
      makeRequest('store_get_state', { framework: 'zustand' }),
    );
    const p = env.payload as { error?: { message: string } };
    expect(p.error?.message).toMatch(/no store detected/);
  });

  it('store_dispatch dispatches and reports framework', async () => {
    const env = await dispatchPageRequest(
      makeRequest('store_dispatch', { action: { type: 'inc' } }),
    );
    const p = env.payload as {
      dispatched: boolean;
      framework: string;
      action: { type: string };
    };
    expect(p.dispatched).toBe(true);
    expect(p.framework).toBe('redux');
    expect(p.action).toEqual({ type: 'inc' });
    expect(store.dispatch).toHaveBeenCalledWith({ type: 'inc' });
  });

  it('store_subscribe reports active + framework, and emitted store_change events carry the framework tag', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const startEnv = await dispatchPageRequest(
      makeRequest('store_subscribe', { action: 'start' }),
    );
    const sp = startEnv.payload as { active: boolean; framework: string };
    expect(sp.active).toBe(true);
    expect(sp.framework).toBe('redux');

    // Trigger a real state change so the subscription emits a store_change.
    store.setState({ counter: { value: 2 } });

    const posted = postSpy.mock.calls.map((c) => JSON.stringify(c[0])).join('\n');
    expect(posted).toMatch(/store_change/);
    expect(posted).toMatch(/"framework":"redux"/);
  });
});
