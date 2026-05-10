import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  discoverShadowRoots,
  attachShadowObserver,
} from '../../src/captures/walk_shadow.js';
import type { Disposer } from '../../src/captures/capture_console.js';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const flushMutations = (): Promise<void> => wait(8);

type MockObserver = {
  callback: MutationCallback;
  target: Node | null;
  init: MutationObserverInit | null;
  disconnectCalls: number;
  fire: (records: MutationRecord[]) => void;
};

const makeMockFactory = (): {
  factory: (cb: MutationCallback) => MutationObserver;
  observers: MockObserver[];
} => {
  const observers: MockObserver[] = [];
  const factory = (cb: MutationCallback): MutationObserver => {
    const mock: MockObserver = {
      callback: cb,
      target: null,
      init: null,
      disconnectCalls: 0,
      fire: (records: MutationRecord[]) => {
        cb(records, fake);
      },
    };
    const fake = {
      observe(target: Node, init?: MutationObserverInit): void {
        mock.target = target;
        mock.init = init ?? null;
      },
      disconnect(): void {
        mock.disconnectCalls += 1;
      },
      takeRecords(): MutationRecord[] {
        return [];
      },
    } as MutationObserver;
    observers.push(mock);
    return fake;
  };
  return { factory, observers };
};

describe('discoverShadowRoots', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns [] for a Node with no shadow descendants', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>plain</span><p>more</p>';
    expect(discoverShadowRoots(root)).toEqual([]);
  });

  it('returns the host shadow when called on a host element', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    expect(discoverShadowRoots(host)).toEqual([shadow]);
  });

  it('returns nested open shadow roots in depth-first parent-first order', () => {
    const outer = document.createElement('div');
    const outerShadow = outer.attachShadow({ mode: 'open' });
    const middle = document.createElement('div');
    outerShadow.appendChild(middle);
    const middleShadow = middle.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    middleShadow.appendChild(inner);
    const innerShadow = inner.attachShadow({ mode: 'open' });

    expect(discoverShadowRoots(outer)).toEqual([
      outerShadow,
      middleShadow,
      innerShadow,
    ]);
  });

  it('walks light-DOM siblings as well as shadow content', () => {
    const root = document.createElement('div');
    const hostA = document.createElement('div');
    const shadowA = hostA.attachShadow({ mode: 'open' });
    const hostB = document.createElement('div');
    const shadowB = hostB.attachShadow({ mode: 'open' });
    root.appendChild(hostA);
    root.appendChild(hostB);

    const roots = discoverShadowRoots(root);
    expect(roots).toContain(shadowA);
    expect(roots).toContain(shadowB);
    expect(roots).toHaveLength(2);
  });

  it('skips closed shadow roots (Element.shadowRoot returns null)', () => {
    const host = document.createElement('div');
    host.attachShadow({ mode: 'closed' });
    const wrapper = document.createElement('div');
    wrapper.appendChild(host);
    expect(discoverShadowRoots(wrapper)).toEqual([]);
  });
});

describe('attachShadowObserver', () => {
  let dispose: Disposer | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    dispose = undefined;
  });

  afterEach(() => {
    if (dispose) dispose();
    document.body.innerHTML = '';
  });

  it('fires onMutation when content inside an existing shadow changes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    await flushMutations();

    const received: Array<{ records: MutationRecord[]; target: ShadowRoot }> =
      [];
    dispose = attachShadowObserver({
      root: document.body,
      onMutation: (records, target) => {
        received.push({ records: [...records], target });
      },
    });

    shadow.appendChild(document.createElement('span'));
    await flushMutations();

    expect(received.length).toBeGreaterThan(0);
    const evt = received[0]!;
    expect(evt.target).toBe(shadow);
    expect(evt.records.some((r) => r.type === 'childList')).toBe(true);
  });

  it('picks up shadows attached at element-creation time (web-component pattern)', async () => {
    const attached: ShadowRoot[] = [];
    dispose = attachShadowObserver({
      root: document.body,
      onMutation: () => {},
      onShadowAttach: (shadow) => attached.push(shadow),
    });

    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(document.createElement('span'));
    document.body.appendChild(host);
    await flushMutations();

    expect(attached).toContain(shadow);
  });

  it('picks up shadows attached AFTER insertion when host receives a light-DOM mutation', async () => {
    const attached: ShadowRoot[] = [];
    dispose = attachShadowObserver({
      root: document.body,
      onMutation: () => {},
      onShadowAttach: (shadow) => attached.push(shadow),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    await flushMutations();
    expect(attached).toHaveLength(0);

    const shadow = host.attachShadow({ mode: 'open' });
    host.appendChild(document.createElement('span'));
    await flushMutations();

    expect(attached).toContain(shadow);
  });

  it('observes mutations inside shadows discovered at install time', async () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    await flushMutations();

    const received: ShadowRoot[] = [];
    dispose = attachShadowObserver({
      root: document.body,
      onMutation: (_records, target) => {
        received.push(target);
      },
    });

    shadow.appendChild(document.createElement('p'));
    await flushMutations();

    expect(received).toContain(shadow);
  });

  it('disposer disconnects every owned observer (count matches discovered + host)', () => {
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);

    const { factory, observers } = makeMockFactory();
    const localDispose = attachShadowObserver({
      root: document.body,
      onMutation: () => {},
      observerFactory: factory,
    });

    expect(observers.length).toBeGreaterThanOrEqual(2);
    expect(observers.every((o) => o.disconnectCalls === 0)).toBe(true);

    localDispose();
    expect(observers.every((o) => o.disconnectCalls === 1)).toBe(true);

    localDispose();
    expect(observers.every((o) => o.disconnectCalls === 1)).toBe(true);
  });

  it('returns a no-op disposer when MutationObserver is unavailable', () => {
    const original = globalThis.MutationObserver;
    (globalThis as unknown as { MutationObserver: undefined }).MutationObserver =
      undefined;
    try {
      const noopDispose = attachShadowObserver({
        root: document.body,
        onMutation: () => {},
      });
      expect(typeof noopDispose).toBe('function');
      expect(() => noopDispose()).not.toThrow();
    } finally {
      globalThis.MutationObserver = original;
    }
  });

  it('swallows onMutation throws without breaking the observer loop', async () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    await flushMutations();

    let firstCall = true;
    let secondCallReceived = false;
    dispose = attachShadowObserver({
      root: document.body,
      onMutation: (_records, _target) => {
        if (firstCall) {
          firstCall = false;
          throw new Error('boom');
        }
        secondCallReceived = true;
      },
    });

    shadow.appendChild(document.createElement('a'));
    await flushMutations();
    shadow.appendChild(document.createElement('b'));
    await flushMutations();

    expect(secondCallReceived).toBe(true);
  });
});
