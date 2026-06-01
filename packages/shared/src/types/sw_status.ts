/**
 * Wire types for the `sw_status` read tool: a projection of the DEBUGGED PWA's
 * service-worker registrations + controller. These answer the highest-volume
 * PWA questions — is there a waiting update, what worker is active, what is
 * controlling the page — without the caller piecing it together from DevTools.
 *
 * Pure type module (no runtime). The projection lives in the extension
 * `sw_app` module; the host `sw_status` tool validates against these shapes.
 */

/** Lifecycle state of a single service worker, mirroring DOM `ServiceWorkerState`. */
export type SwWorkerState =
  | 'parsed'
  | 'installing'
  | 'installed'
  | 'activating'
  | 'activated'
  | 'redundant';

/**
 * A registration's `updateViaCache` policy, mirroring DOM
 * `ServiceWorkerUpdateViaCache`. Directly relevant to "why won't my SW update":
 * `all` lets the HTTP cache serve a stale worker script.
 */
export type SwUpdateViaCache = 'imports' | 'all' | 'none';

/** One service worker (installing/waiting/active/controller) projected to wire. */
export type SwWorkerRecord = {
  readonly scriptURL: string;
  readonly state: SwWorkerState;
};

/** One `navigator.serviceWorker` registration projected to wire. */
export type SwRegistrationRecord = {
  readonly scope: string;
  readonly updateViaCache: SwUpdateViaCache;
  readonly installing: SwWorkerRecord | null;
  readonly waiting: SwWorkerRecord | null;
  readonly active: SwWorkerRecord | null;
  /** `active.scriptURL` for quick version reference; null when no active worker. */
  readonly activeScriptURL: string | null;
  /**
   * True when a `waiting` worker exists — an update installed but not yet
   * activated (blocked behind open clients / no `skipWaiting`). The classic
   * "my update isn't showing" signal.
   */
  readonly hasWaitingUpdate: boolean;
};

/** Full snapshot returned by the `sw_status` read tool. */
export type SwStatusSnapshot = {
  /**
   * True if the page's `navigator.serviceWorker` API exists. False on insecure
   * contexts or unsupported browsers — distinguishes "no SW registered" from
   * "SW not even available here".
   */
  readonly supported: boolean;
  /**
   * The worker currently controlling the page; null if none (e.g. first load
   * before activation, or a shift-reload that bypasses the controller).
   */
  readonly controller: SwWorkerRecord | null;
  readonly registrations: readonly SwRegistrationRecord[];
  /** True if ANY registration has a waiting worker. */
  readonly hasWaitingUpdate: boolean;
};
