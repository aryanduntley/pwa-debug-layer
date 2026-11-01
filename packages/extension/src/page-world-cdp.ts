import { dispatchPageRequest } from './page_bridge/page_dispatch.js';
import { bootPageWorld } from './page_world_boot/boot.js';
import { installCdpBridge, type CdpBridgeStatus } from './page_world_cdp/cdp_bridge.js';

// CDP transport entry: the host injects this bundle over the DevTools Protocol
// (Page.addScriptToEvaluateOnNewDocument + Runtime.evaluate) into pages the
// extension cannot reach, e.g. Android Chrome tabs. See page_world_cdp for the
// wire contract.

export const bootstrap = (): CdpBridgeStatus =>
  installCdpBridge(window as unknown as Record<string, unknown>, {
    dispatch: dispatchPageRequest,
    boot: bootPageWorld,
  });

bootstrap();
