import {
  createCsDispatcher,
  isCsToolRequest,
} from './page_bridge/cs_dispatcher.js';

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

  console.log('[pwa-debug/cs] attached at', location.href);
};

bootstrap();
