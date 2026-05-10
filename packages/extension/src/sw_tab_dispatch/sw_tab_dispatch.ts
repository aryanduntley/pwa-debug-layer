import type {
  CsToolRequest,
  CsToolResponse,
} from '../page_bridge/cs_dispatcher.js';
import {
  classifyDispatchFailure,
  selfHealCsAttachment,
  type PageWorldErrorCode,
} from '../sw_health_probe/sw_health_probe.js';

export type SwTabDispatchOptions = {
  readonly timeoutMs?: number;
};

export type DispatchOk = {
  readonly ok: true;
  readonly response: CsToolResponse;
  readonly selfHealed?: boolean;
};

export type DispatchErr = {
  readonly ok: false;
  readonly code: PageWorldErrorCode;
  readonly message: string;
  readonly selfHealed?: boolean;
};

export type DispatchResult = DispatchOk | DispatchErr;

const DEFAULT_TIMEOUT_MS = 4500;
const SELF_HEAL_SETTLE_MS = 100;

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

const getTabUrl = async (tabId: number): Promise<string | undefined> => {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url;
  } catch {
    return undefined;
  }
};

export const dispatchToTabClassified = async (
  tabId: number,
  req: CsToolRequest,
  opts: SwTabDispatchOptions = {},
): Promise<DispatchResult> => {
  let response: CsToolResponse;
  try {
    response = await dispatchToTab(tabId, req, opts);
  } catch (err) {
    const lastErrorMessage = (err as Error).message;
    const url = await getTabUrl(tabId);
    const failure = await classifyDispatchFailure({
      tabId,
      url,
      lastErrorMessage,
    });
    if (failure.code !== 'cs_not_attached_refresh_tab') {
      return { ok: false, code: failure.code, message: failure.message };
    }
    const heal = await selfHealCsAttachment(tabId);
    if (!heal.ok) {
      return {
        ok: false,
        code: 'cs_inject_failed',
        message: heal.reason,
        selfHealed: true,
      };
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, SELF_HEAL_SETTLE_MS),
    );
    try {
      const retryResponse = await dispatchToTab(tabId, req, opts);
      if (retryResponse.error) {
        return {
          ok: false,
          code: 'page_world_blocked',
          message: retryResponse.error.message,
          selfHealed: true,
        };
      }
      return { ok: true, response: retryResponse, selfHealed: true };
    } catch (retryErr) {
      return {
        ok: false,
        code: 'cs_not_attached_refresh_tab',
        message: (retryErr as Error).message,
        selfHealed: true,
      };
    }
  }
  if (response.error) {
    return {
      ok: false,
      code: 'page_world_blocked',
      message: response.error.message,
    };
  }
  return { ok: true, response };
};

export const dispatchToActiveTabClassified = async (
  req: CsToolRequest,
  opts: SwTabDispatchOptions = {},
): Promise<DispatchResult> => {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) {
    return { ok: false, code: 'no_active_tab', message: 'no active tab' };
  }
  return dispatchToTabClassified(tabId, req, opts);
};
