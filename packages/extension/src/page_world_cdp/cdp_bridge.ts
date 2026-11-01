import {
  encodeRequest,
  encodeResponse,
  type PageBridgeRequestEnvelope,
  type PageBridgeResponseEnvelope,
} from '../page_bridge/protocol.js';
import type { CapturedEvent } from '../captures/types.js';
import {
  EXTENSION_PAGE_WORLD_GUARD,
  type CaptureKinds,
  type PageWorldBootOptions,
  type PageWorldBootResult,
} from '../page_world_boot/boot.js';

import { CDP_BRIDGE_VERSION, CDP_EMIT_BINDING, CDP_GLOBAL } from '@pwa-debug/shared';

// The wire contract (names + version) lives in @pwa-debug/shared so the host
// and this bundle cannot drift apart. Re-exported for existing importers.
export { CDP_BRIDGE_VERSION, CDP_EMIT_BINDING, CDP_GLOBAL };

export type CdpBridgeStatus = {
  readonly version: number;
  readonly captures: 'installed' | 'skipped_extension_present';
  readonly kinds: CaptureKinds | null;
  readonly dropped: number;
  readonly alreadyInstalled: boolean;
};

export type CdpBridgeDeps = {
  readonly dispatch: (req: PageBridgeRequestEnvelope) => Promise<PageBridgeResponseEnvelope>;
  readonly boot: (opts: PageWorldBootOptions) => PageWorldBootResult;
};

type BindingEmitter = {
  readonly emit: (event: CapturedEvent) => void;
  readonly dropped: () => number;
};

/**
 * Emit captured events through the CDP binding as JSON `{ v, event }`. The
 * binding only accepts a string. Events are dropped (and counted) when the
 * binding is absent or the event will not serialise, never thrown into the
 * page code that triggered the capture.
 */
export const createBindingEmitter = (
  win: Record<string, unknown>,
  bindingName: string,
): BindingEmitter => {
  let dropped = 0;
  const emit = (event: CapturedEvent): void => {
    const binding = win[bindingName];
    if (typeof binding !== 'function') {
      dropped += 1;
      return;
    }
    try {
      (binding as (payload: string) => void)(
        JSON.stringify({ v: CDP_BRIDGE_VERSION, event }),
      );
    } catch {
      dropped += 1;
    }
  };
  return Object.freeze({ emit, dropped: () => dropped });
};

const errorEnvelope = (requestId: string, message: string): string =>
  JSON.stringify(encodeResponse({ requestId, error: { message } }));

/**
 * The JSON request channel. The host sends `{ requestId, tool, payload }` and
 * gets back a JSON PageBridgeResponseEnvelope. Strings on both sides keep
 * Runtime.evaluate's returnByValue free of serialisation surprises. Never
 * rejects: bad input becomes an error envelope.
 */
export const createCdpDispatch =
  (dispatch: CdpBridgeDeps['dispatch']) =>
  async (json: string): Promise<string> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return errorEnvelope('', 'cdp dispatch: request is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object') {
      return errorEnvelope('', 'cdp dispatch: request must be an object');
    }
    const r = parsed as Record<string, unknown>;
    const requestId = typeof r['requestId'] === 'string' ? r['requestId'] : '';
    if (requestId === '' || typeof r['tool'] !== 'string' || r['tool'] === '') {
      return errorEnvelope(requestId, 'cdp dispatch: requestId and tool are required strings');
    }
    try {
      const response = await dispatch(
        encodeRequest({
          requestId,
          tool: r['tool'],
          ...(r['payload'] !== undefined ? { payload: r['payload'] } : {}),
        }),
      );
      return JSON.stringify(response);
    } catch (err) {
      return errorEnvelope(requestId, (err as Error).message);
    }
  };

type CdpGlobal = {
  readonly version: number;
  readonly dispatch: (json: string) => Promise<string>;
  readonly status: () => CdpBridgeStatus;
};

/**
 * Install the bridge once per document. A second injection (the host's
 * addScriptToEvaluateOnNewDocument plus a live Runtime.evaluate, or a
 * re-attach) returns the existing status instead of booting again. When the
 * extension page-world already owns this page, only the request channel is
 * added, so captures are not doubled.
 */
export const installCdpBridge = (
  win: Record<string, unknown>,
  deps: CdpBridgeDeps,
): CdpBridgeStatus => {
  const existing = win[CDP_GLOBAL] as CdpGlobal | undefined;
  if (existing !== undefined && typeof existing.status === 'function') {
    return Object.freeze({ ...existing.status(), alreadyInstalled: true });
  }

  const extensionPresent = win[EXTENSION_PAGE_WORLD_GUARD] === true;
  const emitter = createBindingEmitter(win, CDP_EMIT_BINDING);
  const dispatch = createCdpDispatch(deps.dispatch);

  let kinds: CaptureKinds | null = null;
  const status = (): CdpBridgeStatus =>
    Object.freeze({
      version: CDP_BRIDGE_VERSION,
      captures: extensionPresent ? 'skipped_extension_present' : 'installed',
      kinds,
      dropped: emitter.dropped(),
      alreadyInstalled: false,
    });

  const api: CdpGlobal = Object.freeze({ version: CDP_BRIDGE_VERSION, dispatch, status });

  const result = deps.boot({
    emit: emitter.emit,
    installRequestChannel: () => {
      Object.defineProperty(win, CDP_GLOBAL, {
        value: api,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    },
    captures: !extensionPresent,
  });
  kinds = result.kinds;
  return status();
};
