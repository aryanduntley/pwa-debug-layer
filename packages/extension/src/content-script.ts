import {
  createCsDispatcher,
  isCsToolRequest,
  PAGE_EVENT_SW_TAG,
} from './page_bridge/cs_dispatcher.js';
import type { LifecycleCapturedEvent } from './captures/types.js';
import { installCsLifecycleCapture } from './captures/capture_cs_lifecycle.js';
import { computeFrameMeta } from './frame_meta/frame_meta.js';

export const bootstrap = (): void => {
  const dispatcher = createCsDispatcher();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isCsToolRequest(msg)) return false;
    dispatcher.handleSwRequest(msg, sendResponse);
    return true;
  });

  window.addEventListener('message', (event) => {
    dispatcher.handlePageMessage(event);
  });

  const frame = computeFrameMeta();
  const sendLifecycle = (event: LifecycleCapturedEvent): void => {
    try {
      chrome.runtime.sendMessage({ tag: PAGE_EVENT_SW_TAG, event });
    } catch {
      // Page may be tearing down; sendMessage failure is expected on the
      // very last tick. The event is already best-effort.
    }
  };
  installCsLifecycleCapture({ frame, send: sendLifecycle });

  console.log('[pwa-debug/cs] attached at', location.href);
};

bootstrap();
