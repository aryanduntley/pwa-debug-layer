/**
 * Wire contract between the host and the page-world CDP bundle
 * (packages/extension/src/page-world-cdp.ts). Both sides import these, so a
 * rename cannot silently split them. Bump CDP_BRIDGE_VERSION on any change.
 */
export const CDP_BRIDGE_VERSION = 1;

/** Created by the host with Runtime.addBinding before the bundle runs. */
export const CDP_EMIT_BINDING = '__pwaDebugCdpEmit';

/** Page global the host calls through Runtime.evaluate. */
export const CDP_GLOBAL = '__pwaDebugCdp';

/** JSON carried by one CDP_EMIT_BINDING call. */
export type CdpEmitPayload = {
  readonly v: number;
  readonly event: { readonly kind: string; readonly ts: number; readonly [k: string]: unknown };
};

/** JSON request passed to `${CDP_GLOBAL}.dispatch`. */
export type CdpDispatchRequest = {
  readonly requestId: string;
  readonly tool: string;
  readonly payload?: unknown;
};
