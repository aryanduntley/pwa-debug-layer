import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSwLifecycleProducer } from '../../src/sw_lifecycle/sw_lifecycle.js';
import type {
  CapturedEvent,
  LifecycleCapturedEvent,
} from '../../src/captures/types.js';

type Listener = (...args: unknown[]) => void;

type MockEvent = {
  readonly addListener: ReturnType<typeof vi.fn>;
  readonly removeListener: ReturnType<typeof vi.fn>;
  readonly dispatch: (...args: unknown[]) => void;
  readonly listeners: Listener[];
};

const makeMockEvent = (): MockEvent => {
  const listeners: Listener[] = [];
  return {
    addListener: vi.fn((cb: Listener) => {
      listeners.push(cb);
    }),
    removeListener: vi.fn((cb: Listener) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    }),
    dispatch: (...args: unknown[]) => {
      for (const cb of [...listeners]) cb(...args);
    },
    listeners,
  };
};

type MockChrome = {
  readonly tabs: {
    readonly onUpdated: MockEvent;
    readonly onRemoved: MockEvent;
  };
  readonly webNavigation: {
    readonly onCommitted: MockEvent;
    readonly onHistoryStateUpdated: MockEvent;
  };
};

const installChromeMock = (): MockChrome => {
  const mock: MockChrome = {
    tabs: {
      onUpdated: makeMockEvent(),
      onRemoved: makeMockEvent(),
    },
    webNavigation: {
      onCommitted: makeMockEvent(),
      onHistoryStateUpdated: makeMockEvent(),
    },
  };
  vi.stubGlobal('chrome', mock);
  return mock;
};

describe('createSwLifecycleProducer', () => {
  let chromeMock: MockChrome;
  let received: LifecycleCapturedEvent[];
  let dispose: (() => void) | undefined;
  const sink = {
    handle: (e: CapturedEvent): void => {
      received.push(e as LifecycleCapturedEvent);
    },
  };

  beforeEach(() => {
    chromeMock = installChromeMock();
    received = [];
  });

  afterEach(() => {
    if (dispose) dispose();
    dispose = undefined;
    vi.unstubAllGlobals();
  });

  it('emits lifecycle/navigation_committed on chrome.webNavigation.onCommitted', () => {
    dispose = createSwLifecycleProducer({ sink });
    chromeMock.webNavigation.onCommitted.dispatch({
      tabId: 42,
      frameId: 0,
      url: 'https://example.com/x',
      transitionType: 'reload',
      transitionQualifiers: ['forward_back'],
    });

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.kind).toBe('lifecycle');
    expect(evt.source).toBe('sw');
    if (evt.subkind !== 'navigation_committed') {
      throw new Error('expected navigation_committed');
    }
    expect(evt.tabId).toBe(42);
    expect(evt.frameId).toBe(0);
    expect(evt.url).toBe('https://example.com/x');
    expect(evt.transitionType).toBe('reload');
    expect(evt.transitionQualifiers).toEqual(['forward_back']);
    expect(evt.frameUrl).toBe('https://example.com/x');
    expect(evt.frameKey).toBe('top');
  });

  it('emits lifecycle/history_state_updated on chrome.webNavigation.onHistoryStateUpdated', () => {
    dispose = createSwLifecycleProducer({ sink });
    chromeMock.webNavigation.onHistoryStateUpdated.dispatch({
      tabId: 7,
      frameId: 5,
      url: 'https://example.com/spa-route',
      transitionType: 'link',
    });

    const evt = received[0]!;
    if (evt.subkind !== 'history_state_updated') {
      throw new Error('expected history_state_updated');
    }
    expect(evt.tabId).toBe(7);
    expect(evt.frameId).toBe(5);
    expect(evt.url).toBe('https://example.com/spa-route');
    expect(evt.transitionType).toBe('link');
    expect(evt.transitionQualifiers).toBeUndefined();
    expect(evt.frameKey).toBe('frame-5');
  });

  it('emits lifecycle/tab_status only when changeInfo.status changes (loading or complete)', () => {
    dispose = createSwLifecycleProducer({ sink });

    // status:'loading' → emits
    chromeMock.tabs.onUpdated.dispatch(
      99,
      { status: 'loading' },
      { url: 'https://example.com/loading' },
    );
    // status:'complete' → emits
    chromeMock.tabs.onUpdated.dispatch(
      99,
      { status: 'complete' },
      { url: 'https://example.com/done' },
    );
    // url change without status → SKIPPED
    chromeMock.tabs.onUpdated.dispatch(
      99,
      { url: 'https://example.com/url-only' },
      { url: 'https://example.com/url-only' },
    );
    // title change without status → SKIPPED
    chromeMock.tabs.onUpdated.dispatch(
      99,
      { title: 'New title' },
      { url: 'https://example.com/url-only' },
    );
    // favIconUrl change → SKIPPED
    chromeMock.tabs.onUpdated.dispatch(
      99,
      { favIconUrl: 'https://example.com/fav.ico' },
      { url: 'https://example.com/url-only' },
    );

    expect(received).toHaveLength(2);
    const [loadingEvt, completeEvt] = received;
    if (loadingEvt!.subkind !== 'tab_status') {
      throw new Error('expected tab_status');
    }
    expect(loadingEvt!.tabId).toBe(99);
    expect(loadingEvt!.status).toBe('loading');
    expect(loadingEvt!.frameUrl).toBe('https://example.com/loading');
    if (completeEvt!.subkind !== 'tab_status') {
      throw new Error('expected tab_status');
    }
    expect(completeEvt!.status).toBe('complete');
    expect(completeEvt!.frameUrl).toBe('https://example.com/done');
  });

  it('emits lifecycle/tab_removed on chrome.tabs.onRemoved', () => {
    dispose = createSwLifecycleProducer({ sink });
    chromeMock.tabs.onRemoved.dispatch(123, {
      isWindowClosing: true,
      windowId: 1,
    });

    const evt = received[0]!;
    if (evt.subkind !== 'tab_removed') {
      throw new Error('expected tab_removed');
    }
    expect(evt.tabId).toBe(123);
    expect(evt.isWindowClosing).toBe(true);
    expect(evt.frameUrl).toBe('');
    expect(evt.frameKey).toBe('top');
  });

  it('uses getTabUrl as fallback when tab.url is missing on tab_status', () => {
    dispose = createSwLifecycleProducer({
      sink,
      getTabUrl: (tabId) =>
        tabId === 555 ? 'https://from-resolver/x' : undefined,
    });
    chromeMock.tabs.onUpdated.dispatch(
      555,
      { status: 'complete' },
      { url: undefined },
    );

    const evt = received[0]!;
    if (evt.subkind !== 'tab_status') {
      throw new Error('expected tab_status');
    }
    expect(evt.frameUrl).toBe('https://from-resolver/x');
  });

  it('disposer removes every installed listener and is idempotent', () => {
    dispose = createSwLifecycleProducer({ sink });
    expect(chromeMock.webNavigation.onCommitted.listeners).toHaveLength(1);
    expect(chromeMock.webNavigation.onHistoryStateUpdated.listeners).toHaveLength(1);
    expect(chromeMock.tabs.onUpdated.listeners).toHaveLength(1);
    expect(chromeMock.tabs.onRemoved.listeners).toHaveLength(1);

    dispose();
    expect(chromeMock.webNavigation.onCommitted.removeListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.webNavigation.onHistoryStateUpdated.removeListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.webNavigation.onCommitted.listeners).toHaveLength(0);
    expect(chromeMock.tabs.onRemoved.listeners).toHaveLength(0);

    // Idempotent: second dispose is a no-op (removeListener counts unchanged).
    dispose();
    expect(chromeMock.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);

    // Post-dispose dispatches reach no listeners.
    chromeMock.webNavigation.onCommitted.dispatch({
      tabId: 1,
      frameId: 0,
      url: 'https://x',
    });
    chromeMock.tabs.onRemoved.dispatch(1, {
      isWindowClosing: false,
      windowId: 1,
    });
    expect(received).toHaveLength(0);
    dispose = undefined;
  });

  it('opts.enabled selectively skips listener install', () => {
    dispose = createSwLifecycleProducer({
      sink,
      opts: { enabled: { tab_removed: false, history_state_updated: false } },
    });
    expect(chromeMock.webNavigation.onCommitted.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.webNavigation.onHistoryStateUpdated.addListener).not.toHaveBeenCalled();
    expect(chromeMock.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.onRemoved.addListener).not.toHaveBeenCalled();

    // Disabled subkinds: dispatching does nothing because no listener is registered.
    chromeMock.tabs.onRemoved.dispatch(1, {
      isWindowClosing: false,
      windowId: 1,
    });
    chromeMock.webNavigation.onHistoryStateUpdated.dispatch({
      tabId: 1,
      frameId: 0,
      url: 'https://x',
    });
    expect(received).toHaveLength(0);

    // Enabled subkinds still work.
    chromeMock.webNavigation.onCommitted.dispatch({
      tabId: 1,
      frameId: 0,
      url: 'https://x',
    });
    chromeMock.tabs.onUpdated.dispatch(
      1,
      { status: 'complete' },
      { url: 'https://x' },
    );
    expect(received).toHaveLength(2);
  });

  it('returns no-op disposer when chrome runtime is unavailable', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', undefined);
    received = [];
    const noop = createSwLifecycleProducer({ sink });
    expect(typeof noop).toBe('function');
    expect(() => noop()).not.toThrow();
  });
});
