import { isSwRequestEnvelope, routeRequest } from './request_router.js';
import {
  createEventSink,
  isPageEventSwMessage,
  type EventSink,
} from './sw_event_sink/sw_event_sink.js';
import { createSwLifecycleProducer } from './sw_lifecycle/sw_lifecycle.js';
import type { CapturedEvent } from './captures/types.js';

const HOST_NAME = 'com.pwa_debug.host';
const CAPTURES_EVENT_TOOL = 'captures';

type PortRef = { current: chrome.runtime.Port | null };

const installEventSinkListener = (sink: EventSink): void => {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!isPageEventSwMessage(msg)) return;
    sink.handle(msg.event as CapturedEvent);
  });
};

const logSetupHint = (extId: string, errorMessage?: string): void => {
  const reason = errorMessage ? `: ${errorMessage}` : '';
  console.warn(
    `[pwa-debug/sw] native host not registered for this extension${reason}\n` +
      `[pwa-debug/sw] To register, ask Claude (or any MCP client) to call:\n` +
      `[pwa-debug/sw]   mcp__pwa_debug__host_register_extension { extension_id: "${extId}" }\n` +
      `[pwa-debug/sw] Then reload this extension at chrome://extensions and the connect will retry.`,
  );
};

const connectNativeHost = (sink: EventSink, portRef: PortRef): void => {
  const extId = chrome.runtime.id;
  console.log(`[pwa-debug/sw] connecting to native host: ${HOST_NAME}`);

  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    logSetupHint(extId, (e as Error).message);
    return;
  }

  portRef.current = port;

  port.onMessage.addListener((msg) => {
    if (isSwRequestEnvelope(msg)) {
      routeRequest(msg, { sink }).then(
        (response) => {
          try {
            port.postMessage(response);
          } catch (err) {
            console.warn(
              '[pwa-debug/sw] postMessage failed:',
              (err as Error).message,
            );
          }
        },
        (err: Error) => {
          console.warn(
            '[pwa-debug/sw] routeRequest rejected (should not happen):',
            err.message,
          );
        },
      );
      return;
    }
    console.log('[pwa-debug/sw] from host:', msg);
  });

  port.onDisconnect.addListener(() => {
    portRef.current = null;
    const err = chrome.runtime.lastError;
    const msg = err?.message ?? '';
    if (/not found|forbidden|access/i.test(msg)) {
      logSetupHint(extId, msg);
    } else if (msg.length > 0) {
      console.log('[pwa-debug/sw] native port disconnected:', msg);
    } else {
      console.log('[pwa-debug/sw] native port disconnected (clean)');
    }
  });
};

export const bootstrap = (): void => {
  chrome.runtime.onInstalled.addListener((details) => {
    console.log('[pwa-debug/sw] installed:', details.reason);
  });
  console.log(`[pwa-debug/sw] id=${chrome.runtime.id}`);
  console.log('[pwa-debug/sw] up');

  const portRef: PortRef = { current: null };
  const extensionId = chrome.runtime.id;

  const sendEventEnvelope = (events: readonly CapturedEvent[]): void => {
    const port = portRef.current;
    if (port === null) return;
    try {
      port.postMessage({
        type: 'event',
        tool: CAPTURES_EVENT_TOOL,
        extensionId,
        payload: { events },
      });
    } catch (err) {
      console.warn(
        '[pwa-debug/sw] event flush postMessage failed:',
        (err as Error).message,
      );
    }
  };

  const sink = createEventSink({
    logger: (event) => {
      console.log('[pwa-debug/sw] event', event.kind, event);
    },
    forwardEvents: sendEventEnvelope,
  });
  installEventSinkListener(sink);
  createSwLifecycleProducer({ sink });
  connectNativeHost(sink, portRef);
};

bootstrap();
