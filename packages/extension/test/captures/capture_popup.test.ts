import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installPopupCapture,
  matchLibrary,
  POPUP_SIGNATURES,
} from '../../src/captures/capture_popup.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type { PopupCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://example.com/popup',
  frameKey: 'top',
};

// Target-aware fake observer harness: records which node(s) each observer
// watches so a test can fire "the observer(s) watching X" — the body observer
// (root) vs each per-popup widget observer (the node / shadow root).
const makeObserverHarness = (): {
  factory: (cb: MutationCallback) => MutationObserver;
  fireObserving: (target: Node, records: Array<Partial<MutationRecord>>) => void;
} => {
  type Rec = { cb: MutationCallback; targets: Node[]; observer: MutationObserver };
  const recs: Rec[] = [];
  const factory = (cb: MutationCallback): MutationObserver => {
    const rec: Rec = { cb, targets: [], observer: null as unknown as MutationObserver };
    const observer = {
      observe: (t: Node) => rec.targets.push(t),
      disconnect: () => {},
      takeRecords: () => [],
    } as unknown as MutationObserver;
    rec.observer = observer;
    recs.push(rec);
    return observer;
  };
  const fireObserving = (
    target: Node,
    records: Array<Partial<MutationRecord>>,
  ): void => {
    for (const rec of recs) {
      if (rec.targets.includes(target)) {
        rec.cb(records as MutationRecord[], rec.observer);
      }
    }
  };
  return { factory, fireObserving };
};

const childListRecord = (
  added: Node[],
  removed: Node[] = [],
): Partial<MutationRecord> => ({
  type: 'childList',
  addedNodes: added as unknown as NodeList,
  removedNodes: removed as unknown as NodeList,
});

describe('matchLibrary', () => {
  it('tags walletconnect web3modal custom elements', () => {
    expect(matchLibrary(document.createElement('w3m-modal'))).toBe('walletconnect');
    expect(matchLibrary(document.createElement('wcm-modal'))).toBe('walletconnect');
  });

  it('tags rainbowkit via [data-rk]', () => {
    const el = document.createElement('div');
    el.setAttribute('data-rk', '');
    expect(matchLibrary(el)).toBe('rainbowkit');
  });

  it('tags connectkit via class substring', () => {
    const el = document.createElement('div');
    el.className = 'connectkit-overlay';
    expect(matchLibrary(el)).toBe('connectkit');
  });

  it('tags privy via id prefix', () => {
    const el = document.createElement('div');
    el.id = 'privy-dialog';
    expect(matchLibrary(el)).toBe('privy');
  });

  it("falls back to 'unknown' for an unrecognized host", () => {
    expect(matchLibrary(document.createElement('div'))).toBe('unknown');
  });

  it('returns the first matching signature in registry order', () => {
    expect(POPUP_SIGNATURES.length).toBeGreaterThan(0);
    expect(POPUP_SIGNATURES[0]!.library).toBe('walletconnect');
  });
});

describe('installPopupCapture — shadow detection', () => {
  let received: PopupCapturedEvent[];
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    received = [];
    document.body.innerHTML = '';
  });

  afterEach(() => {
    if (dispose) dispose();
    dispose = undefined;
    document.body.innerHTML = '';
  });

  it("emits 'appeared'/'shadow' with a state snapshot when a shadow attaches after install", () => {
    let n = 0;
    dispose = installPopupCapture((e) => received.push(e), FRAME, {
      idGen: () => `id-${(n += 1)}`,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }); // fires synchronously; shadow empty here

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.phase).toBe('appeared');
    expect(evt.detection).toBe('shadow');
    expect(evt.popupId).toBe('id-1');
    expect(evt.state?.visible).toBe(true);
  });

  it('does NOT emit for a shadow root present at install (page baseline)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }); // before install

    dispose = installPopupCapture((e) => received.push(e), FRAME);
    expect(received).toHaveLength(0);
  });

  it('ignores closed shadow roots', () => {
    dispose = installPopupCapture((e) => received.push(e), FRAME);
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'closed' });
    expect(received).toHaveLength(0);
  });
});

describe('installPopupCapture — portal detection', () => {
  let received: PopupCapturedEvent[];
  let dispose: (() => void) | undefined;
  let harness: ReturnType<typeof makeObserverHarness>;

  beforeEach(() => {
    received = [];
    document.body.innerHTML = '';
    harness = makeObserverHarness();
  });

  afterEach(() => {
    if (dispose) dispose();
    dispose = undefined;
    document.body.innerHTML = '';
  });

  const install = (): void => {
    let n = 0;
    dispose = installPopupCapture((e) => received.push(e), FRAME, {
      observerFactory: harness.factory,
      idGen: () => `p-${(n += 1)}`,
    });
  };

  it("emits 'appeared'/'portal' with a state snapshot, tagged by library", () => {
    install();
    const node = document.createElement('w3m-modal');
    node.style.position = 'fixed';
    node.style.zIndex = '2000';
    node.innerHTML = '<h2>Connect a wallet</h2><button>MetaMask</button>';
    document.body.appendChild(node);

    harness.fireObserving(document.body, [childListRecord([node])]);

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.phase).toBe('appeared');
    expect(evt.detection).toBe('portal');
    expect(evt.library).toBe('walletconnect');
    expect(evt.popupId).toBe('p-1');
    expect(evt.state?.title).toBe('Connect a wallet');
    expect(evt.state?.buttons).toEqual([{ label: 'MetaMask', role: 'button' }]);
  });

  it('ignores added nodes that are not high-z fixed/sticky overlays', () => {
    install();
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    harness.fireObserving(document.body, [childListRecord([plain])]);
    expect(received).toHaveLength(0);
  });

  it("emits 'disappeared' (no state) with the same popupId when the node leaves", () => {
    install();
    const node = document.createElement('div');
    node.style.position = 'fixed';
    node.style.zIndex = '5000';
    document.body.appendChild(node);
    harness.fireObserving(document.body, [childListRecord([node])]);
    const appearedId = received[0]!.popupId;

    node.remove();
    harness.fireObserving(document.body, [childListRecord([], [node])]);

    expect(received).toHaveLength(2);
    const gone = received[1]!;
    expect(gone.phase).toBe('disappeared');
    expect(gone.popupId).toBe(appearedId);
    expect(gone.state).toBeUndefined();
  });

  it('dedupes a node already tracked (no duplicate appeared)', () => {
    install();
    const node = document.createElement('div');
    node.style.position = 'fixed';
    node.style.zIndex = '5000';
    document.body.appendChild(node);
    harness.fireObserving(document.body, [childListRecord([node])]);
    harness.fireObserving(document.body, [childListRecord([node])]);
    expect(received.filter((e) => e.phase === 'appeared')).toHaveLength(1);
  });
});

describe('installPopupCapture — debounced updated re-snapshot', () => {
  let received: PopupCapturedEvent[];
  let dispose: (() => void) | undefined;
  let harness: ReturnType<typeof makeObserverHarness>;

  beforeEach(() => {
    vi.useFakeTimers();
    received = [];
    document.body.innerHTML = '';
    harness = makeObserverHarness();
  });

  afterEach(() => {
    if (dispose) dispose();
    dispose = undefined;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it("emits 'updated' with fresh state when widget content changes", () => {
    let n = 0;
    dispose = installPopupCapture((e) => received.push(e), FRAME, {
      observerFactory: harness.factory,
      idGen: () => `u-${(n += 1)}`,
      updateDebounceMs: 50,
    });

    const node = document.createElement('div');
    node.style.position = 'fixed';
    node.style.zIndex = '5000';
    node.innerHTML = '<h2>Loading…</h2>';
    document.body.appendChild(node);
    harness.fireObserving(document.body, [childListRecord([node])]);
    expect(received).toHaveLength(1);
    expect(received[0]!.state?.title).toBe('Loading…');

    // Content changes; the per-popup widget observer fires.
    node.innerHTML = '<h2>Connect a wallet</h2><button>Approve</button>';
    harness.fireObserving(node, [childListRecord([])]);
    vi.runAllTimers();

    const updated = received.filter((e) => e.phase === 'updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.state?.title).toBe('Connect a wallet');
    expect(updated[0]!.popupId).toBe('u-1');
  });

  it("surfaces an in-widget failure via an 'updated' event", () => {
    let n = 0;
    dispose = installPopupCapture((e) => received.push(e), FRAME, {
      observerFactory: harness.factory,
      idGen: () => `f-${(n += 1)}`,
      updateDebounceMs: 50,
    });

    const node = document.createElement('div');
    node.style.position = 'fixed';
    node.style.zIndex = '5000';
    node.innerHTML = '<h2>Connect a wallet</h2>';
    document.body.appendChild(node);
    harness.fireObserving(document.body, [childListRecord([node])]);
    expect(received[0]!.state?.failure).toBeUndefined();

    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'Connection failed: user rejected the request.';
    node.appendChild(alert);
    harness.fireObserving(node, [childListRecord([alert])]);
    vi.runAllTimers();

    const updated = received.filter((e) => e.phase === 'updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.state?.failure?.reason).toBe(
      'Connection failed: user rejected the request.',
    );
  });

  it("does NOT emit 'updated' when the snapshot signature is unchanged", () => {
    dispose = installPopupCapture((e) => received.push(e), FRAME, {
      observerFactory: harness.factory,
      updateDebounceMs: 50,
    });

    const node = document.createElement('div');
    node.style.position = 'fixed';
    node.style.zIndex = '5000';
    node.innerHTML = '<h2>Stable</h2>';
    document.body.appendChild(node);
    harness.fireObserving(document.body, [childListRecord([node])]);

    // Fire the widget observer without any meaningful content change.
    harness.fireObserving(node, [childListRecord([])]);
    vi.runAllTimers();

    expect(received.filter((e) => e.phase === 'updated')).toHaveLength(0);
  });
});

describe('installPopupCapture — two-tier (primary/nested)', () => {
  let received: PopupCapturedEvent[];
  let dispose: (() => void) | undefined;
  let harness: ReturnType<typeof makeObserverHarness>;

  beforeEach(() => {
    received = [];
    document.body.innerHTML = '';
    harness = makeObserverHarness();
  });

  afterEach(() => {
    if (dispose) dispose();
    dispose = undefined;
    document.body.innerHTML = '';
  });

  const install = (): void => {
    let n = 0;
    dispose = installPopupCapture((e) => received.push(e), FRAME, {
      observerFactory: harness.factory,
      idGen: () => `id-${(n += 1)}`,
    });
  };

  it('classifies a shadow host inside a tracked popup as nested with parentPopupId', () => {
    install();
    // Primary widget: <w3m-modal> attaches its shadow after install.
    const modal = document.createElement('w3m-modal');
    document.body.appendChild(modal);
    const modalRoot = modal.attachShadow({ mode: 'open' });
    // A component web element rendered INSIDE the modal's shadow tree.
    const inner = document.createElement('wui-flex');
    modalRoot.appendChild(inner);
    inner.attachShadow({ mode: 'open' });

    expect(received).toHaveLength(2);
    const [primary, nested] = received;
    expect(primary!.host.tagName).toBe('W3M-MODAL');
    expect(primary!.role).toBe('primary');
    expect(primary!.parentPopupId).toBeNull();
    expect(primary!.library).toBe('walletconnect');

    expect(nested!.host.tagName).toBe('WUI-FLEX');
    expect(nested!.role).toBe('nested');
    expect(nested!.parentPopupId).toBe(primary!.popupId);
  });

  it('surfaces a single primary popup for a one-host widget (fixture <w3m-modal>)', () => {
    install();
    const modal = document.createElement('w3m-modal');
    document.body.appendChild(modal);
    modal.attachShadow({ mode: 'open' });

    const primaries = received.filter((e) => e.role === 'primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.parentPopupId).toBeNull();
  });

  it('does NOT attach an update observer to nested components', () => {
    install();
    const modal = document.createElement('w3m-modal');
    document.body.appendChild(modal);
    const modalRoot = modal.attachShadow({ mode: 'open' });
    const inner = document.createElement('wui-flex');
    modalRoot.appendChild(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });

    // Firing a mutation at the nested shadow root reaches no observer, so no
    // 'updated' storm from nested components.
    harness.fireObserving(innerRoot, [childListRecord([])]);
    expect(received.filter((e) => e.phase === 'updated')).toHaveLength(0);
  });

  it('re-snapshots the primary (updated) as nested components render content', () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const events: PopupCapturedEvent[] = [];
      const d = installPopupCapture((e) => events.push(e), FRAME, {
        observerFactory: harness.factory,
        idGen: () => `id-${(n += 1)}`,
        updateDebounceMs: 50,
      });

      const modal = document.createElement('w3m-modal');
      document.body.appendChild(modal);
      const modalRoot = modal.attachShadow({ mode: 'open' }); // primary, empty

      // A nested component attaches, then fills its own shadow with content.
      const inner = document.createElement('w3m-router');
      modalRoot.appendChild(inner);
      const innerRoot = inner.attachShadow({ mode: 'open' });
      innerRoot.innerHTML = '<h1>Connect a wallet</h1>';

      vi.runAllTimers(); // flush the debounced primary re-snapshot

      const primaryUpdated = events.filter(
        (e) => e.role === 'primary' && e.phase === 'updated',
      );
      expect(primaryUpdated.length).toBeGreaterThanOrEqual(1);
      // The primary now carries the content that lives in the nested shadow.
      expect(primaryUpdated[primaryUpdated.length - 1]!.state?.title).toBe(
        'Connect a wallet',
      );
      d();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retroactively re-parents a popup when its enclosing parent registers later', () => {
    install();
    // Child custom element is a light-DOM descendant of the parent, and its
    // shadow upgrades BEFORE the parent attaches its own shadow.
    const parent = document.createElement('w3m-modal');
    const child = document.createElement('wui-flex');
    parent.appendChild(child);
    document.body.appendChild(parent);

    child.attachShadow({ mode: 'open' }); // child registers first → primary
    parent.attachShadow({ mode: 'open' }); // parent now encloses child

    const childAppeared = received.find(
      (e) => e.host.tagName === 'WUI-FLEX' && e.phase === 'appeared',
    );
    const parentAppeared = received.find(
      (e) => e.host.tagName === 'W3M-MODAL' && e.phase === 'appeared',
    );
    const childReparent = received.find(
      (e) => e.host.tagName === 'WUI-FLEX' && e.phase === 'updated',
    );

    expect(childAppeared!.role).toBe('primary'); // first seen as top-level
    expect(parentAppeared!.role).toBe('primary');
    expect(parentAppeared!.parentPopupId).toBeNull();
    // Corrective re-parent event re-tags the child as nested under the parent.
    expect(childReparent).toBeDefined();
    expect(childReparent!.role).toBe('nested');
    expect(childReparent!.parentPopupId).toBe(parentAppeared!.popupId);
  });
});

describe('installPopupCapture — environment + disposer', () => {
  it('disposer is idempotent', () => {
    const dispose = installPopupCapture(() => {}, FRAME, {
      observerFactory: makeObserverHarness().factory,
    });
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });
});
