import type { Disposer } from '../captures/capture_console.js';
import type {
  CapturedEvent,
  LifecycleCapturedEvent,
  SwLifecyclePayload,
  SwLifecycleSubkind,
} from '../captures/types.js';

export type SwLifecycleProducerOptions = {
  readonly enabled?: Partial<Record<SwLifecycleSubkind, boolean>>;
};

type SwLifecycleProducerDeps = {
  readonly sink: { readonly handle: (event: CapturedEvent) => void };
  readonly opts?: SwLifecycleProducerOptions;
  readonly getTabUrl?: (tabId: number) => string | undefined;
};

const isEnabled = (
  opts: SwLifecycleProducerOptions | undefined,
  subkind: SwLifecycleSubkind,
): boolean => opts?.enabled?.[subkind] !== false;

const frameKeyFor = (frameId?: number): string =>
  frameId === undefined || frameId === 0 ? 'top' : `frame-${frameId}`;

export const createSwLifecycleProducer = (
  deps: SwLifecycleProducerDeps,
): Disposer => {
  if (
    typeof chrome === 'undefined' ||
    !chrome.tabs ||
    !chrome.webNavigation
  ) {
    return () => {};
  }

  const { sink, opts, getTabUrl } = deps;
  const now = (): number => Date.now();
  let disposed = false;
  const cleanups: Array<() => void> = [];

  const tryEmit = (event: LifecycleCapturedEvent): void => {
    if (disposed) return;
    try {
      sink.handle(event);
    } catch {
      // Capture failure must never break the SW.
    }
  };

  const buildEvent = (
    payload: SwLifecyclePayload,
    frameUrl: string,
    frameKey: string,
  ): LifecycleCapturedEvent =>
    Object.freeze({
      kind: 'lifecycle',
      source: 'sw',
      ts: now(),
      frameUrl,
      frameKey,
      ...payload,
    }) as LifecycleCapturedEvent;

  if (isEnabled(opts, 'navigation_committed')) {
    const onCommitted = (
      d: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    ): void => {
      const payload: SwLifecyclePayload = {
        subkind: 'navigation_committed',
        tabId: d.tabId,
        frameId: d.frameId,
        url: d.url,
        ...(d.transitionType ? { transitionType: d.transitionType } : {}),
        ...(d.transitionQualifiers
          ? { transitionQualifiers: d.transitionQualifiers }
          : {}),
      };
      tryEmit(buildEvent(payload, d.url, frameKeyFor(d.frameId)));
    };
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    cleanups.push(() =>
      chrome.webNavigation.onCommitted.removeListener(onCommitted),
    );
  }

  if (isEnabled(opts, 'history_state_updated')) {
    const onHistory = (
      d: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    ): void => {
      const payload: SwLifecyclePayload = {
        subkind: 'history_state_updated',
        tabId: d.tabId,
        frameId: d.frameId,
        url: d.url,
        ...(d.transitionType ? { transitionType: d.transitionType } : {}),
        ...(d.transitionQualifiers
          ? { transitionQualifiers: d.transitionQualifiers }
          : {}),
      };
      tryEmit(buildEvent(payload, d.url, frameKeyFor(d.frameId)));
    };
    chrome.webNavigation.onHistoryStateUpdated.addListener(onHistory);
    cleanups.push(() =>
      chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistory),
    );
  }

  if (isEnabled(opts, 'tab_status')) {
    const onUpdated = (
      tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') {
        return;
      }
      const payload: SwLifecyclePayload = {
        subkind: 'tab_status',
        tabId,
        status: changeInfo.status,
      };
      const url = tab.url ?? getTabUrl?.(tabId) ?? '';
      tryEmit(buildEvent(payload, url, 'top'));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    cleanups.push(() => chrome.tabs.onUpdated.removeListener(onUpdated));
  }

  if (isEnabled(opts, 'tab_removed')) {
    const onRemoved = (
      tabId: number,
      removeInfo: chrome.tabs.TabRemoveInfo,
    ): void => {
      const payload: SwLifecyclePayload = {
        subkind: 'tab_removed',
        tabId,
        isWindowClosing: removeInfo.isWindowClosing,
      };
      const url = getTabUrl?.(tabId) ?? '';
      tryEmit(buildEvent(payload, url, 'top'));
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    cleanups.push(() => chrome.tabs.onRemoved.removeListener(onRemoved));
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Ignore cleanup failures.
      }
    }
  };
};
