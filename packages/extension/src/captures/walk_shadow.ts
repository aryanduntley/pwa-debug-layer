// Open shadow roots only. Closed shadow roots are intentionally out of scope:
// Element.shadowRoot returns null for closed mode per spec, so per-shadow
// MutationObservers cannot attach to them even when discovered.
//
// M13 T-F adds a narrow Element.prototype.attachShadow patch (installAttachShadowPatch)
// to fire shadow-attach notifications synchronously on creation regardless of mode.
// We still skip closed shadows in the listener (init.mode === 'open' check) — the
// patch is a TIMING fix for open shadows, not a closed-shadow capture mechanism.
// Without the patch, walk_shadow misses shadows attached to a host that subsequently
// receives zero light-DOM mutations (T-E real-Brave repro: m13-test.html shadow-host
// got attachShadow + sr.innerHTML + setTimeout sr.appendChild with zero captures).
//
// Cross-frame walking is also out of scope here — iframe content is handled by
// manifest content_scripts.all_frames=true plus frameId tagging (M13 T-C),
// not by traversing through iframe.contentDocument from this walker.

import type { Disposer } from './capture_console.js';

const DEFAULT_MUTATION_INIT: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeOldValue: true,
  characterData: true,
  characterDataOldValue: true,
};

const HOST_OBSERVER_INIT: MutationObserverInit = {
  childList: true,
  subtree: true,
};

export type ShadowMutationListener = (
  records: readonly MutationRecord[],
  target: ShadowRoot,
) => void;

export type ShadowAttachListener = (shadow: ShadowRoot) => void;

export type AttachShadowObserverOptions = {
  readonly root: Node;
  readonly onMutation: ShadowMutationListener;
  readonly onShadowAttach?: ShadowAttachListener;
  readonly observerFactory?: (callback: MutationCallback) => MutationObserver;
  readonly mutationInit?: MutationObserverInit;
};

export const discoverShadowRoots = (node: Node): ShadowRoot[] => {
  const out: ShadowRoot[] = [];
  walkForShadows(node, out);
  return out;
};

const walkForShadows = (node: Node, out: ShadowRoot[]): void => {
  if (node.nodeType === 1) {
    const element = node as Element;
    const shadow = element.shadowRoot;
    if (shadow !== null) {
      out.push(shadow);
      walkForShadows(shadow, out);
    }
  }
  const children = (node as Partial<ParentNode>).children;
  if (children === undefined) return;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child !== undefined) walkForShadows(child, out);
  }
};

export const attachShadowObserver = (
  opts: AttachShadowObserverOptions,
): Disposer => {
  if (typeof MutationObserver === 'undefined' || typeof Node === 'undefined') {
    return () => {};
  }

  const observerFactory =
    opts.observerFactory ?? ((cb): MutationObserver => new MutationObserver(cb));
  const mutationInit = opts.mutationInit ?? DEFAULT_MUTATION_INIT;

  const observers: MutationObserver[] = [];
  const seen = new WeakSet<ShadowRoot>();
  let disposed = false;

  const notifyMutation = (
    records: readonly MutationRecord[],
    target: ShadowRoot,
  ): void => {
    try {
      opts.onMutation(records, target);
    } catch {
      // Observer callbacks must never throw — capture failures stay contained.
    }
  };

  const notifyAttach = (shadow: ShadowRoot): void => {
    if (opts.onShadowAttach === undefined) return;
    try {
      opts.onShadowAttach(shadow);
    } catch {
      // Observer callbacks must never throw — capture failures stay contained.
    }
  };

  const scanAndObserve = (subtree: Node): void => {
    if (disposed) return;
    const roots = discoverShadowRoots(subtree);
    for (const shadow of roots) {
      if (seen.has(shadow)) continue;
      notifyAttach(shadow);
      observeShadow(shadow);
    }
  };

  const observeShadow = (shadow: ShadowRoot): void => {
    if (seen.has(shadow)) return;
    seen.add(shadow);
    const observer = observerFactory((records) => {
      if (disposed) return;
      notifyMutation(records, shadow);
      for (const record of records) {
        if (record.type !== 'childList') continue;
        for (let i = 0; i < record.addedNodes.length; i += 1) {
          const added = record.addedNodes[i];
          if (added !== undefined) scanAndObserve(added);
        }
      }
    });
    try {
      observer.observe(shadow, mutationInit);
      observers.push(observer);
    } catch {
      // Target may have been detached between discovery and observe; skip.
    }
  };

  scanAndObserve(opts.root);

  // T-F attachShadow patch: catch attach-after-insert cases where the host
  // subsequently receives no light-DOM mutations. Synchronous on creation —
  // the per-shadow MutationObserver attaches before any user-script content
  // (sr.innerHTML / sr.appendChild) runs in the same tick.
  const attachPatchDispose = installAttachShadowPatch((shadow) => {
    if (disposed) return;
    if (seen.has(shadow)) return;
    notifyAttach(shadow);
    observeShadow(shadow);
  });

  // Host-tree observer: childList additions can introduce new shadow hosts.
  // attachShadow() itself fires no mutation, so detection rides on neighbouring
  // tree activity. Two paths covered:
  //   1) Web-component construction: host attaches shadow during constructor +
  //      is inserted into the tree → addedNodes contains the host, and
  //      scanAndObserve walks into its already-attached shadow.
  //   2) Post-insertion attachShadow: host is in the tree, attachShadow runs
  //      with no mutation, then any later childList on the host (e.g. light-DOM
  //      child added, slot content moved) fires a record with target=host. We
  //      re-check target.shadowRoot to pick up the now-present shadow.
  // Edge case not handled: attachShadow() on an existing element followed by
  // zero further mutations on that host. Accepted — no captures would be lost
  // because no shadow content exists to observe.
  const hostObserver = observerFactory((records) => {
    if (disposed) return;
    for (const record of records) {
      if (record.type !== 'childList') continue;
      if (record.target.nodeType === 1) {
        const targetEl = record.target as Element;
        const targetShadow = targetEl.shadowRoot;
        if (targetShadow !== null && !seen.has(targetShadow)) {
          notifyAttach(targetShadow);
          observeShadow(targetShadow);
          scanAndObserve(targetShadow);
        }
      }
      for (let i = 0; i < record.addedNodes.length; i += 1) {
        const added = record.addedNodes[i];
        if (added !== undefined) scanAndObserve(added);
      }
    }
  });
  try {
    hostObserver.observe(opts.root, HOST_OBSERVER_INIT);
    observers.push(hostObserver);
  } catch {
    // root is not a node MutationObserver can observe (eg. Attr); skip silently.
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const observer of observers) {
      observer.disconnect();
    }
    observers.length = 0;
    attachPatchDispose();
  };
};

const ATTACH_SHADOW_PATCH_MARKER = Symbol.for(
  'pwa-debug:walk_shadow:attachShadowPatched',
);
const attachShadowListeners = new Set<ShadowAttachListener>();
let originalAttachShadow:
  | ((this: Element, init: ShadowRootInit) => ShadowRoot)
  | null = null;

export const installAttachShadowPatch = (
  onAttach: ShadowAttachListener,
): Disposer => {
  if (typeof Element === 'undefined') return () => {};
  const proto = Element.prototype as Element & {
    [ATTACH_SHADOW_PATCH_MARKER]?: boolean;
  };
  if (proto[ATTACH_SHADOW_PATCH_MARKER] !== true) {
    const raw = (Element.prototype as { attachShadow?: unknown }).attachShadow;
    if (typeof raw !== 'function') return () => {};
    originalAttachShadow = raw as (
      this: Element,
      init: ShadowRootInit,
    ) => ShadowRoot;
    Element.prototype.attachShadow = function patchedAttachShadow(
      this: Element,
      init: ShadowRootInit,
    ): ShadowRoot {
      const shadow = originalAttachShadow!.call(this, init);
      if (init !== undefined && init.mode === 'open') {
        for (const listener of attachShadowListeners) {
          try {
            listener(shadow);
          } catch {
            // listener failures must not break the host's attachShadow call
          }
        }
      }
      return shadow;
    };
    proto[ATTACH_SHADOW_PATCH_MARKER] = true;
  }
  attachShadowListeners.add(onAttach);
  return () => {
    attachShadowListeners.delete(onAttach);
    if (attachShadowListeners.size === 0 && originalAttachShadow !== null) {
      Element.prototype.attachShadow = originalAttachShadow;
      const proto = Element.prototype as Element & {
        [ATTACH_SHADOW_PATCH_MARKER]?: boolean;
      };
      delete proto[ATTACH_SHADOW_PATCH_MARKER];
      originalAttachShadow = null;
    }
  };
};
