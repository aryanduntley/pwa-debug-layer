import type {
  CsToolRequest,
  CsToolResponse,
} from '../page_bridge/cs_dispatcher.js';

export type SwTabDispatchOptions = {
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 4500;

export const dispatchToTab = async (
  tabId: number,
  req: CsToolRequest,
  opts: SwTabDispatchOptions = {},
): Promise<CsToolResponse> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `sw-tab-dispatch timeout after ${timeoutMs}ms (tabId=${tabId})`,
        ),
      );
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, req),
      timeoutPromise,
    ]);
    return response as CsToolResponse;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
};

export const dispatchToActiveTab = async (
  req: CsToolRequest,
  opts: SwTabDispatchOptions = {},
): Promise<CsToolResponse> => {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) {
    throw new Error('no active tab');
  }
  return dispatchToTab(tabId, req, opts);
};
