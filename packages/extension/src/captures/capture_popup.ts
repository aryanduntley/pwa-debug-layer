// Library-popup producer (Path 6 M-A + M-B). Generic detection of any injected
// overlay via two paths feeding one emit pipeline:
//   1) SHADOW  — an OPEN shadow root attached AFTER install (the genuine
//      "injection" signal). We reuse installAttachShadowPatch from walk_shadow
//      to fire synchronously on attachShadow. Shadow roots already present at
//      install are page baseline (every web component uses shadow DOM) and are
//      seeded into a skip-set via discoverShadowRoots so they never emit.
//   2) PORTAL  — a high-z-index fixed/sticky Element added under the document
//      tree (React/Vue portals append overlays to <body>). A MutationObserver
//      on the document root childList+subtree catches them on add.
//
// M-B: each detected popup carries a PopupState content snapshot (buildPopupState)
// on appeared, and re-emits a debounced 'updated' when its content meaningfully
// changes (per-popup MutationObserver on the widget subtree). popupId is stable
// across appeared→updated→disappeared; removal is detected by sweeping tracked
// hosts for !isConnected. All emits are wrapped so capture never breaks the page.

import { safeRandomId } from '../ids/safe_random_id.js';
import { discoverShadowRoots, installAttachShadowPatch } from './walk_shadow.js';
import { buildPopupState, type PopupSnapshotOptions } from './popup_snapshot.js';
import type { Disposer, FrameMeta } from './capture_console.js';
import type {
  PopupCapturedEvent,
  PopupDetection,
  PopupHostSummary,
  PopupPhase,
  PopupState,
} from './types.js';

const DEFAULT_MIN_Z_INDEX = 1000;
const DEFAULT_UPDATE_DEBOUNCE_MS = 50;

const WIDGET_OBSERVER_INIT: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
};

/** One pluggable library-popup signature: a tag + a predicate over the host. */
export type PopupSignature = {
  readonly library: string;
  readonly match: (host: Element) => boolean;
};

export type PopupCaptureOptions = {
  /** Portal overlay z-index threshold (default 1000). */
  readonly minZIndex?: number;
  /** Override the registry (unit tests). */
  readonly signatures?: readonly PopupSignature[];
  /** Injectable observer constructor (unit tests). */
  readonly observerFactory?: (callback: MutationCallback) => MutationObserver;
  /** Injectable stable-id source (unit tests). */
  readonly idGen?: () => string;
  /** Content-snapshot options forwarded to buildPopupState. */
  readonly snapshot?: PopupSnapshotOptions;
  /** Debounce window for 'updated' re-snapshots (default 50ms). */
  readonly updateDebounceMs?: number;
};

// --- signature registry -----------------------------------------------------

const matchesSelector = (host: Element, selector: string): boolean => {
  try {
    return host.matches(selector);
  } catch {
    return false;
  }
};

const tagLower = (host: Element): string => host.tagName.toLowerCase();

/**
 * Known-widget signatures. Adding a widget is data-only: push an entry here.
 * Predicates are host-level only and must never throw (matchLibrary guards too).
 */
export const POPUP_SIGNATURES: readonly PopupSignature[] = [
  {
    library: 'walletconnect',
    // Web3Modal/WalletConnect modal custom elements: <w3m-modal>, <wcm-modal>,
    // and the wcm-*/w3m-* element family.
    match: (host) => {
      const tag = tagLower(host);
      return tag.startsWith('w3m-') || tag.startsWith('wcm-');
    },
  },
  {
    library: 'rainbowkit',
    match: (host) => matchesSelector(host, '[data-rk], #rainbowkit, [data-rk] *'),
  },
  {
    library: 'connectkit',
    match: (host) =>
      matchesSelector(host, '[class*="connectkit"], [class*="ck-"], [data-ck]'),
  },
  {
    library: 'privy',
    match: (host) =>
      matchesSelector(host, '[id^="privy-"], iframe[src*="privy"], #privy-dialog'),
  },
];

export const matchLibrary = (
  host: Element,
  signatures: readonly PopupSignature[] = POPUP_SIGNATURES,
): string => {
  for (const sig of signatures) {
    try {
      if (sig.match(host)) return sig.library;
    } catch {
      // A faulty predicate must not abort the rest of the registry.
    }
  }
  return 'unknown';
};

// --- host summary ------------------------------------------------------------

const cssEscape = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value;

const buildSelector = (host: Element): string => {
  const tag = tagLower(host);
  if (host.id) return `${tag}#${cssEscape(host.id)}`;
  const classes = Array.from(host.classList).slice(0, 3);
  if (classes.length > 0) {
    return tag + classes.map((c) => `.${cssEscape(c)}`).join('');
  }
  return tag;
};

const buildHostSummary = (host: Element): PopupHostSummary => {
  const classes = Array.from(host.classList);
  return {
    tagName: host.tagName,
    ...(host.id ? { id: host.id } : {}),
    ...(classes.length > 0 ? { classes } : {}),
    selector: buildSelector(host),
  };
};

// --- portal heuristic --------------------------------------------------------

const isPortalOverlay = (node: Node, minZIndex: number): node is Element => {
  if (node.nodeType !== 1) return false;
  if (typeof getComputedStyle !== 'function') return false;
  try {
    const style = getComputedStyle(node as Element);
    if (style.position !== 'fixed' && style.position !== 'sticky') return false;
    const z = parseInt(style.zIndex, 10);
    return Number.isFinite(z) && z >= minZIndex;
  } catch {
    return false;
  }
};

// --- state signature (dedupes 'updated' to meaningful changes) ---------------

const stateSignature = (state: PopupState): string => {
  try {
    return JSON.stringify({
      visible: state.visible,
      title: state.title,
      text: state.text,
      buttons: state.buttons,
      alerts: state.alerts,
      failure: state.failure?.reason,
    });
  } catch {
    return `${state.visible}|${state.title ?? ''}|${state.text ?? ''}|${state.failure?.reason ?? ''}`;
  }
};

// --- producer ----------------------------------------------------------------

type TrackedPopup = {
  readonly popupId: string;
  readonly detection: PopupDetection;
  readonly library: string;
  readonly hostSummary: PopupHostSummary;
  readonly contentRoot: ParentNode & Node;
  lastSig: string;
  readonly observers: MutationObserver[];
  timer: ReturnType<typeof setTimeout> | null;
};

export const installPopupCapture = (
  emit: (event: PopupCapturedEvent) => void,
  frame: FrameMeta,
  opts?: PopupCaptureOptions,
): Disposer => {
  if (
    typeof MutationObserver === 'undefined' ||
    typeof document === 'undefined' ||
    typeof Element === 'undefined'
  ) {
    return () => {};
  }

  const minZIndex = opts?.minZIndex ?? DEFAULT_MIN_Z_INDEX;
  const signatures = opts?.signatures ?? POPUP_SIGNATURES;
  const observerFactory =
    opts?.observerFactory ??
    ((cb): MutationObserver => new MutationObserver(cb));
  const idGen = opts?.idGen ?? ((): string => safeRandomId('popup_'));
  const snapshotOpts = opts?.snapshot;
  const debounceMs = opts?.updateDebounceMs ?? DEFAULT_UPDATE_DEBOUNCE_MS;
  const now = (): number => Date.now();

  let disposed = false;
  const tracked = new Map<Element, TrackedPopup>();
  // Shadow hosts present at install are baseline page structure, not popups.
  const baselineShadowHosts = new WeakSet<Element>();
  for (const shadow of discoverShadowRoots(document)) {
    if (shadow.host) baselineShadowHosts.add(shadow.host);
  }

  const makeEvent = (
    info: TrackedPopup,
    phase: PopupPhase,
    state?: PopupState,
  ): PopupCapturedEvent =>
    Object.freeze({
      kind: 'library_popup',
      ts: now(),
      frameUrl: frame.frameUrl,
      frameKey: frame.frameKey,
      ...(frame.isCrossOrigin !== undefined
        ? { isCrossOrigin: frame.isCrossOrigin }
        : {}),
      popupId: info.popupId,
      phase,
      detection: info.detection,
      library: info.library,
      host: info.hostSummary,
      ...(state !== undefined ? { state } : {}),
    }) as PopupCapturedEvent;

  const tryEmit = (event: PopupCapturedEvent): void => {
    try {
      emit(event);
    } catch {
      // Capture failure must never break the page.
    }
  };

  const snapshot = (host: Element, contentRoot: ParentNode & Node): PopupState | undefined => {
    try {
      return buildPopupState(host, contentRoot, snapshotOpts);
    } catch {
      return undefined;
    }
  };

  const reSnapshot = (host: Element): void => {
    if (disposed) return;
    const info = tracked.get(host);
    if (info === undefined) return;
    info.timer = null;
    const state = snapshot(host, info.contentRoot);
    if (state === undefined) return;
    const sig = stateSignature(state);
    if (sig === info.lastSig) return; // no meaningful change
    info.lastSig = sig;
    tryEmit(makeEvent(info, 'updated', state));
  };

  const scheduleReSnapshot = (host: Element): void => {
    const info = tracked.get(host);
    if (info === undefined || info.timer !== null) return;
    info.timer = setTimeout(() => reSnapshot(host), debounceMs);
  };

  const observeWidget = (
    host: Element,
    contentRoot: ParentNode & Node,
  ): MutationObserver[] => {
    const observers: MutationObserver[] = [];
    const add = (target: Node, init: MutationObserverInit): void => {
      const observer = observerFactory(() => {
        if (!disposed) scheduleReSnapshot(host);
      });
      try {
        observer.observe(target, init);
        observers.push(observer);
      } catch {
        // Target not observable (e.g. detached); skip.
      }
    };
    add(contentRoot, WIDGET_OBSERVER_INIT);
    // Visibility/class/style changes on a shadow host don't show up inside the
    // shadow root, so watch the host's attributes too when it differs.
    if (host !== (contentRoot as unknown as Element)) {
      add(host, { attributes: true });
    }
    return observers;
  };

  const registerPopup = (
    host: Element,
    detection: PopupDetection,
    contentRoot: ParentNode & Node,
  ): void => {
    if (disposed || tracked.has(host)) return;
    const state = snapshot(host, contentRoot);
    const info: TrackedPopup = {
      popupId: idGen(),
      detection,
      library: matchLibrary(host, signatures),
      hostSummary: buildHostSummary(host),
      contentRoot,
      lastSig: state !== undefined ? stateSignature(state) : '',
      observers: [],
      timer: null,
    };
    tracked.set(host, info);
    tryEmit(makeEvent(info, 'appeared', state));
    info.observers.push(...observeWidget(host, contentRoot));
  };

  const teardown = (info: TrackedPopup): void => {
    for (const observer of info.observers) observer.disconnect();
    info.observers.length = 0;
    if (info.timer !== null) {
      clearTimeout(info.timer);
      info.timer = null;
    }
  };

  const sweepRemovals = (): void => {
    if (disposed || tracked.size === 0) return;
    for (const [host, info] of tracked) {
      if (!host.isConnected) {
        tracked.delete(host);
        teardown(info);
        tryEmit(makeEvent(info, 'disappeared'));
      }
    }
  };

  // SHADOW: only shadows attached AFTER install (genuine injections) emit.
  const attachDispose = installAttachShadowPatch((shadow) => {
    if (disposed) return;
    const host = shadow.host;
    if (host && !baselineShadowHosts.has(host)) {
      registerPopup(host, 'shadow', shadow);
    }
  });

  // PORTAL: high-z fixed/sticky elements added anywhere under the document root.
  const onBodyMutations = (records: readonly MutationRecord[]): void => {
    if (disposed) return;
    for (const record of records) {
      if (record.type !== 'childList') continue;
      for (let i = 0; i < record.addedNodes.length; i += 1) {
        const added = record.addedNodes[i];
        if (added !== undefined && isPortalOverlay(added, minZIndex)) {
          registerPopup(added, 'portal', added);
        }
      }
    }
    sweepRemovals();
  };

  const bodyObserver = observerFactory((records) => onBodyMutations(records));
  const root = document.body ?? document.documentElement;
  try {
    bodyObserver.observe(root, { childList: true, subtree: true });
  } catch {
    attachDispose();
    return () => {};
  }

  return () => {
    if (disposed) return;
    disposed = true;
    attachDispose();
    bodyObserver.disconnect();
    for (const info of tracked.values()) teardown(info);
    tracked.clear();
  };
};
