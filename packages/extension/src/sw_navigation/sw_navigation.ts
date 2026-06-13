// SW-side navigation primitives — wraps chrome.tabs URL navigation so the request
// router stays a thin orchestrator. SW-handled (NOT page-world): chrome.tabs is
// only reachable in the extension service worker, and driving the tab to a new URL
// is a browser action, not an in-page read. This is the pwa-debug counterpart to
// chrome-devtools-mcp's navigate_page/new_page — it works through the loaded
// extension on the user's real profile, with no CDP attach required.

/** Result of a navigate / new-tab action. status reflects whether the page reached
 *  document 'complete' within the wait window; 'loading' means it was still loading
 *  when the wait timed out (the navigation still happened). */
export type NavResult = {
  readonly tabId: number;
  readonly url: string;
  readonly windowId?: number;
  readonly status: 'complete' | 'loading';
  /** Present and true only for new_tab — the tab was created, not reused. */
  readonly created?: boolean;
};

const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

// A bare javascript: URL would run script in the target page context on navigate;
// reject it. Everything else (http(s), file:, about:, data:, chrome:, localhost
// shorthand) is allowed — this is a debugging driver, not a sandbox.
const JAVASCRIPT_SCHEME = /^javascript:/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Normalize a caller-supplied URL: trim, reject empty / javascript:, and assume
 * https:// when no scheme is given (so `example.com` works). Returns null when the
 * input is unusable so the caller can surface a clear error.
 */
export const normalizeUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (JAVASCRIPT_SCHEME.test(trimmed)) return null;
  return HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/** Active tab id in the last-focused window, or undefined when there is none. */
const activeTabId = async (): Promise<number | undefined> => {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0]?.id;
};

/**
 * Resolve once the tab reports document 'complete', or 'timeout' after timeoutMs.
 * The onUpdated listener is added BEFORE the caller triggers the load so the
 * 'complete' event can't be missed; it is always removed and the timer cleared.
 */
const waitForComplete = (
  tabId: number,
  timeoutMs: number,
): Promise<'complete' | 'timeout'> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: 'complete' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(outcome);
    };
    const onUpdated = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
    ): void => {
      if (id === tabId && info.status === 'complete') settle('complete');
    };
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

/**
 * Navigate the active (or given) tab to url and wait for it to finish loading.
 * Throws on an invalid url or when no tab can be resolved. The listener is armed
 * before chrome.tabs.update so the fresh load's 'complete' is observed.
 */
export const navigateTab = async (input: {
  readonly tabId?: number;
  readonly url: string;
  readonly timeoutMs?: number;
}): Promise<NavResult> => {
  const url = normalizeUrl(input.url);
  if (url === null) {
    throw new Error(`navigate: invalid or unsupported url: ${JSON.stringify(input.url)}`);
  }
  const tabId = input.tabId ?? (await activeTabId());
  if (tabId === undefined) {
    throw new Error('navigate: no active tab (open a tab or pass tab_id)');
  }
  const pending = waitForComplete(tabId, input.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);
  const tab = await chrome.tabs.update(tabId, { url });
  const outcome = await pending;
  return {
    tabId,
    url,
    ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
    status: outcome === 'complete' ? 'complete' : 'loading',
  };
};

/**
 * Open a new tab at url and wait for it to finish loading. active defaults to
 * Chrome's behavior (foreground). Throws on an invalid url or when Chrome returns
 * no tab id.
 */
export const openNewTab = async (input: {
  readonly url: string;
  readonly active?: boolean;
  readonly timeoutMs?: number;
}): Promise<NavResult> => {
  const url = normalizeUrl(input.url);
  if (url === null) {
    throw new Error(`new_tab: invalid or unsupported url: ${JSON.stringify(input.url)}`);
  }
  const tab = await chrome.tabs.create({
    url,
    ...(input.active !== undefined ? { active: input.active } : {}),
  });
  const tabId = tab.id;
  if (tabId === undefined) {
    throw new Error('new_tab: chrome did not return a tab id');
  }
  const outcome = await waitForComplete(
    tabId,
    input.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
  );
  return {
    tabId,
    url,
    ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
    status: outcome === 'complete' ? 'complete' : 'loading',
    created: true,
  };
};
