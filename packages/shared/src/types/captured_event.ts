import type { SwWorkerState } from './sw_status.js';

export type CaptureMeta = {
  readonly ts: number;
  readonly frameUrl: string;
  readonly frameKey: string;
  readonly frameId?: number;
  readonly isCrossOrigin?: boolean;
};

export type ConsoleLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace';

export type ConsoleCapturedEvent = CaptureMeta & {
  readonly kind: 'console';
  readonly level: ConsoleLevel;
  readonly args: readonly unknown[];
  readonly stack?: string;
};

export type FetchCapturedEvent = CaptureMeta & {
  readonly kind: 'fetch';
  readonly phase: 'request' | 'response' | 'error';
  readonly captureId: string;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly body?: unknown;
  readonly durationMs?: number;
};

export type XhrCapturedEvent = CaptureMeta & {
  readonly kind: 'xhr';
  readonly phase: 'request' | 'response' | 'error';
  readonly captureId: string;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly responseType?: string;
  readonly body?: unknown;
  readonly durationMs?: number;
};

export type WebSocketCapturedEvent = CaptureMeta & {
  readonly kind: 'websocket';
  readonly subkind: 'open' | 'frame' | 'close' | 'error';
  readonly connectionId: string;
  readonly url?: string;
  readonly direction?: 'send' | 'receive';
  readonly frameType?: 'text' | 'binary';
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
};

export type NodeSummary = {
  readonly nodeId: string;
  readonly nodeType: number;
  readonly tagName?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly childCount?: number;
  readonly textContent?: string;
  readonly truncated?: boolean;
};

export type DomMutationPatch =
  | {
      readonly kind: 'childList';
      readonly target: NodeSummary;
      readonly added: readonly NodeSummary[];
      readonly removed: readonly NodeSummary[];
    }
  | {
      readonly kind: 'attributes';
      readonly target: NodeSummary;
      readonly name: string;
      readonly oldValue: string | null;
      readonly newValue: string | null;
    }
  | {
      readonly kind: 'characterData';
      readonly target: NodeSummary;
      readonly oldValue: string;
      readonly newValue: string;
    }
  | {
      readonly kind: 'overflow';
      readonly dropped: number;
    };

export type DomMutationCapturedEvent = CaptureMeta & {
  readonly kind: 'dom_mutation';
  readonly patches: readonly DomMutationPatch[];
};

export type DomMutationCaptureOptions = {
  readonly depthCap?: number;
  readonly coalesceWindowMs?: number;
  readonly maxPatchesPerEvent?: number;
};

export type PageLifecycleSubkind =
  | 'pageshow'
  | 'pagehide'
  | 'visibilitychange'
  | 'beforeunload'
  | 'navigation'
  | 'popstate';

export type PageLifecyclePayload =
  | { readonly subkind: 'pageshow'; readonly persisted: boolean }
  | { readonly subkind: 'pagehide'; readonly persisted: boolean }
  | {
      readonly subkind: 'visibilitychange';
      readonly visibilityState: 'visible' | 'hidden';
    }
  | { readonly subkind: 'beforeunload' }
  | {
      readonly subkind: 'navigation';
      readonly method: 'pushState' | 'replaceState';
      readonly url: string;
      readonly title?: string;
      readonly state?: unknown;
    }
  | {
      readonly subkind: 'popstate';
      readonly url: string;
      readonly state?: unknown;
    };

export type SwLifecycleSubkind =
  | 'navigation_committed'
  | 'history_state_updated'
  | 'tab_status'
  | 'tab_removed';

export type SwLifecyclePayload =
  | {
      readonly subkind: 'navigation_committed';
      readonly tabId: number;
      readonly frameId: number;
      readonly url: string;
      readonly transitionType?: string;
      readonly transitionQualifiers?: readonly string[];
    }
  | {
      readonly subkind: 'history_state_updated';
      readonly tabId: number;
      readonly frameId: number;
      readonly url: string;
      readonly transitionType?: string;
      readonly transitionQualifiers?: readonly string[];
    }
  | {
      readonly subkind: 'tab_status';
      readonly tabId: number;
      readonly status: 'loading' | 'complete';
    }
  | {
      readonly subkind: 'tab_removed';
      readonly tabId: number;
      readonly isWindowClosing: boolean;
    };

export type CsLifecycleSubkind = 'pagehide';

export type CsLifecyclePayload = {
  readonly subkind: 'pagehide';
  readonly persisted: boolean;
};

export type LifecycleSubkind =
  | PageLifecycleSubkind
  | SwLifecycleSubkind
  | CsLifecycleSubkind;

export type LifecycleCapturedEvent =
  | (CaptureMeta & { readonly kind: 'lifecycle'; readonly source: 'page' } & PageLifecyclePayload)
  | (CaptureMeta & { readonly kind: 'lifecycle'; readonly source: 'sw' } & SwLifecyclePayload)
  | (CaptureMeta & { readonly kind: 'lifecycle'; readonly source: 'cs' } & CsLifecyclePayload);

export type LifecycleCaptureOptions = {
  readonly enabled?: Partial<Record<PageLifecycleSubkind, boolean>>;
};

export type StoreChangeAction = {
  readonly type: string;
  readonly payload?: unknown;
};

export type StoreChangeDiff = {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
};

/**
 * Emitted by the page-world Redux subscription manager on each store.subscribe
 * callback whose path-narrowed snapshot differs from the prior snapshot. The
 * `snapshot` field is the serialized (16KB-capped) post-state of the watched
 * slice; the `diff` field names the top-level keys that changed.
 */
export type StoreChangeCapturedEvent = CaptureMeta & {
  readonly kind: 'store_change';
  readonly storeId: string;
  /** Framework tag of the adapter that detected the store (e.g. 'redux',
   *  'zustand'). Stamped by the store_subscribe page handler so tail entries
   *  are self-describing. Optional for backward compatibility with pre-M2
   *  events that predate multi-store detection. */
  readonly framework?: string;
  readonly path?: string;
  readonly action?: StoreChangeAction;
  readonly diff: StoreChangeDiff;
  readonly snapshot: unknown;
  readonly truncated?: boolean;
};

/**
 * Emitted by the page-world rrweb_record manager (M12 T1) on each rrweb event
 * while a recording is active. The `data` field is the raw rrweb event payload
 * — opaque to the capture pipeline; consumers (session_replay tool) pass it
 * through to AI agents who can replay or analyze it.
 *
 * rrwebType is rrweb's event-type number (rrweb's EventType enum: 0=DomContentLoaded,
 * 1=Load, 2=FullSnapshot, 3=IncrementalSnapshot, 4=Meta, 5=Custom, 6=Plugin).
 */
export type ReplayCapturedEvent = CaptureMeta & {
  readonly kind: 'replay';
  readonly sessionId: string;
  readonly rrwebType: number;
  readonly data: unknown;
  readonly timestamp: number;
};

/** Minimal identity of the DOM element a popup was injected as/under. */
export type PopupHostSummary = {
  readonly tagName: string;
  readonly id?: string;
  readonly classes?: readonly string[];
  /** A best-effort CSS selector locating the host element. */
  readonly selector: string;
};

export type PopupPhase = 'appeared' | 'updated' | 'disappeared';

/** How the popup was detected: an attached open shadow root, or a light-DOM portal overlay under <body>. */
export type PopupDetection = 'shadow' | 'portal';

/**
 * Classification of a detected popup within a widget tree.
 * - 'primary': a top-level popup with no enclosing tracked popup (the logical
 *   widget, e.g. a Reown <w3m-modal> or a React portal overlay).
 * - 'nested': a popup host that lives inside an already-tracked popup's subtree
 *   (across shadow boundaries) — e.g. the <wui-*>/<ph-*> web components Reown
 *   renders inside the modal. Surfaced only when explicitly requested so the
 *   live view shows one popup per widget, not one per component.
 * Absent role is treated as 'primary' by consumers (backward compatibility).
 */
export type PopupRole = 'primary' | 'nested';

/** An actionable control detected inside a popup (label + ARIA role, typically 'button'). */
export type PopupActionButton = {
  readonly label: string;
  readonly role: string;
};

/**
 * A detected auth/connect failure signal rendered inside a popup widget: the
 * human-readable reason (an alert message or failure-copy match). Carried on
 * PopupState.failure; the host popup_failures tool correlates it with console
 * and network errors that fired during the popup's open window.
 */
export type PopupFailure = {
  readonly reason: string;
};

/**
 * Structured snapshot of a detected popup's content (shadow root or portal
 * subtree). Carried on PopupCapturedEvent.state for the appeared/updated phases
 * (omitted on disappeared). Built by the page-world popup-snapshot helper from
 * dom_serialize.summarizeNode + dom_aria role/name primitives.
 */
export type PopupState = {
  /** Whether the widget is currently shown. */
  readonly visible: boolean;
  /** Widget heading / accessible name. */
  readonly title?: string;
  /** Visible text content, capped. */
  readonly text?: string;
  /** Actionable controls (Connect, Cancel, ...). */
  readonly buttons?: readonly PopupActionButton[];
  /** Alert / aria-live region texts rendered inside the widget. */
  readonly alerts?: readonly string[];
  /** Set when the widget content looks like an auth/connect failure. */
  readonly failure?: PopupFailure;
  /** Optional depth-capped structural summary of the widget subtree. */
  readonly content?: NodeSummary;
  readonly truncated?: boolean;
};

export type PopupCapturedEvent = CaptureMeta & {
  readonly kind: 'library_popup';
  /** Stable id for one popup instance across its appeared -> updated -> disappeared lifecycle. */
  readonly popupId: string;
  readonly phase: PopupPhase;
  readonly detection: PopupDetection;
  /** Tagged library when a signature matched (e.g. 'walletconnect', 'rainbowkit'), else 'unknown'. */
  readonly library: string;
  readonly host: PopupHostSummary;
  /**
   * Classification within a widget tree (see PopupRole). The producer always
   * stamps this; absent is treated as 'primary' for backward compatibility.
   */
  readonly role?: PopupRole;
  /**
   * popupId of the nearest enclosing tracked popup (the IMMEDIATE parent in the
   * widget tree, which may itself be nested), or null when this event is a
   * primary (top-level) popup. Follow the parentPopupId chain up to the
   * role:'primary' root to find the owning widget; the immediate-parent links
   * let consumers reconstruct the full hierarchy.
   */
  readonly parentPopupId?: string | null;
  /** Content snapshot, present on appeared/updated, omitted on disappeared. */
  readonly state?: PopupState;
};

/**
 * An uncaught error surfaced at the page level: a window 'error' (ErrorEvent /
 * window.onerror) or an 'unhandledrejection' (PromiseRejectionEvent). Captured
 * app- and framework-agnostically so the AI sees thrown failures (including
 * wallet/connect rejections that bubble) without the app having to log them.
 * Errors an app fully catches do NOT surface here (by definition).
 */
export type PageErrorCapturedEvent = CaptureMeta & {
  readonly kind: 'page_error';
  /**
   * 'error' = window 'error'/onerror; 'unhandledrejection' = a rejected promise
   * the app didn't catch; 'wallet_rejection' = an EIP-1193 provider .request()
   * rejection observed at the provider boundary (e.g. code 4001 user-rejected),
   * captured even when the app catches it.
   */
  readonly subkind: 'error' | 'unhandledrejection' | 'wallet_rejection';
  /** Human-readable message (Error.message, the rejection reason, or stringified value), capped. */
  readonly message: string;
  /** Error constructor name when available (e.g. 'TypeError', 'UserRejectedRequestError'). */
  readonly name?: string;
  /** Stack trace with extension frames stripped, when available. */
  readonly stack?: string;
  /** For window 'error' events: originating script location 'url:line:col'. */
  readonly source?: string;
};

/** Which service-worker lifecycle transition of the DEBUGGED PWA fired. */
export type SwStateSubkind = 'updatefound' | 'statechange' | 'controllerchange';

/**
 * A captured service-worker lifecycle transition of the debugged PWA, read from
 * the page's navigator.serviceWorker and flowing through the capture pipeline as
 * kind 'sw_state'. Distinct from the SW-side 'lifecycle' kind (which is page
 * navigation / tab events emitted by the extension's own service worker).
 *
 * - updatefound: a registration started installing a NEW worker (the
 *   'an update is downloading' moment).
 * - statechange: a worker advanced lifecycle state
 *   (installing→installed→activating→activated→redundant).
 * - controllerchange: the worker controlling the page changed (a new SW took
 *   control, typically after skipWaiting + clients.claim).
 */
export type SwStateCapturedEvent = CaptureMeta & {
  readonly kind: 'sw_state';
  readonly subkind: SwStateSubkind;
  /** The registration scope the event came from, when known. */
  readonly scope?: string;
  /** Script URL of the worker the event concerns (the new/changed worker or new controller). */
  readonly scriptURL?: string;
  /** The worker's lifecycle state at emit time (always present for statechange). */
  readonly state?: SwWorkerState;
  /** Which registration slot the worker occupies at emit time, when known. */
  readonly slot?: 'installing' | 'waiting' | 'active';
};

export type CapturedEvent =
  | ConsoleCapturedEvent
  | FetchCapturedEvent
  | XhrCapturedEvent
  | WebSocketCapturedEvent
  | DomMutationCapturedEvent
  | LifecycleCapturedEvent
  | StoreChangeCapturedEvent
  | ReplayCapturedEvent
  | PopupCapturedEvent
  | PageErrorCapturedEvent
  | SwStateCapturedEvent;
