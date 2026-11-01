import {
  encodeEvent,
  isInboundCsToPage,
} from './page_bridge/protocol.js';
import { dispatchPageRequest } from './page_bridge/page_dispatch.js';
import type { CapturedEvent } from './captures/types.js';
import {
  bootPageWorld,
  EXTENSION_PAGE_WORLD_GUARD,
} from './page_world_boot/boot.js';

// Extension transport: requests arrive from the content script as postMessage
// envelopes, and captured events leave the same way.

const installBridgeListener = (): void => {
  window.addEventListener('message', (event) => {
    if (!isInboundCsToPage(event)) return;
    dispatchPageRequest(event.data).then(
      (response) => {
        window.postMessage(response, window.location.origin);
      },
      (err: Error) => {
        console.warn(
          '[pwa-debug/page] dispatchPageRequest rejected (should not happen):',
          err.message,
        );
      },
    );
  });
};

const emit = (event: CapturedEvent): void => {
  window.postMessage(encodeEvent(event), window.location.origin);
};

export const bootstrap = (): void => {
  // Idempotency guard. page-world.js can run more than once in the same MAIN
  // world: the manifest injects it at document_start, and the SW self-heal
  // (sw_health_probe) re-injects it via chrome.scripting.executeScript. After an
  // extension reload the original page-world is orphaned but STILL running (a
  // MAIN-world 'message' listener survives reload — there is no navigation), so
  // a second bootstrap would register a DUPLICATE bridge listener and capture
  // set. Two bridge listeners dispatch every cs->page request twice, making
  // every mutating pdl_* action (click/fill/check/...) run twice. The flag lives
  // on `window` and persists across the reload, so the re-injection no-ops here
  // and the (orphaned-but-functional) original listener stays the sole handler.
  const w = window as unknown as Record<string, unknown>;
  if (w[EXTENSION_PAGE_WORLD_GUARD]) return;
  Object.defineProperty(window, EXTENSION_PAGE_WORLD_GUARD, {
    value: true,
    configurable: true,
  });

  bootPageWorld({ emit, installRequestChannel: installBridgeListener });
};

bootstrap();
