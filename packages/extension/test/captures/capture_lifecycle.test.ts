import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installLifecycleCapture } from '../../src/captures/capture_lifecycle.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type { LifecycleCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://example.com/lifecycle',
  frameKey: 'top',
};

const dispatchPageTransition = (
  type: 'pageshow' | 'pagehide',
  persisted: boolean,
): void => {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
};

const dispatchPopstate = (state: unknown): void => {
  const event = new Event('popstate');
  Object.defineProperty(event, 'state', { value: state });
  window.dispatchEvent(event);
};

describe('installLifecycleCapture', () => {
  let received: LifecycleCapturedEvent[];
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    received = [];
    dispose = installLifecycleCapture((e) => {
      received.push(e);
    }, FRAME);
  });

  afterEach(() => {
    if (dispose) dispose();
    dispose = undefined;
    history.replaceState(null, '', '/');
  });

  it('emits lifecycle/pageshow with persisted:false', () => {
    dispatchPageTransition('pageshow', false);

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.kind).toBe('lifecycle');
    expect(evt.source).toBe('page');
    expect(evt.frameUrl).toBe(FRAME.frameUrl);
    if (evt.subkind !== 'pageshow') throw new Error('expected pageshow');
    expect(evt.persisted).toBe(false);
  });

  it('emits lifecycle/pageshow with persisted:true (bfcache restore)', () => {
    dispatchPageTransition('pageshow', true);

    const evt = received[0]!;
    if (evt.subkind !== 'pageshow') throw new Error('expected pageshow');
    expect(evt.persisted).toBe(true);
  });

  it('emits lifecycle/pagehide with persisted', () => {
    dispatchPageTransition('pagehide', true);

    const evt = received[0]!;
    expect(evt.kind).toBe('lifecycle');
    if (evt.subkind !== 'pagehide') throw new Error('expected pagehide');
    expect(evt.persisted).toBe(true);
  });

  it('emits lifecycle/visibilitychange with current document.visibilityState', () => {
    const original = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    try {
      document.dispatchEvent(new Event('visibilitychange'));

      expect(received).toHaveLength(1);
      const evt = received[0]!;
      if (evt.subkind !== 'visibilitychange') {
        throw new Error('expected visibilitychange');
      }
      expect(evt.visibilityState).toBe('hidden');
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        value: original,
        configurable: true,
      });
    }
  });

  it('emits lifecycle/beforeunload as a signal-only event', () => {
    window.dispatchEvent(new Event('beforeunload'));

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.kind).toBe('lifecycle');
    expect(evt.source).toBe('page');
    if (evt.subkind !== 'beforeunload') {
      throw new Error('expected beforeunload');
    }
    // No extra payload fields beyond meta + kind/source/subkind.
    expect((evt as Record<string, unknown>).persisted).toBeUndefined();
    expect((evt as Record<string, unknown>).state).toBeUndefined();
  });

  it('emits lifecycle/popstate with serialized state from the event', () => {
    dispatchPopstate({ a: 1, nested: { b: 2 } });

    const evt = received[0]!;
    if (evt.subkind !== 'popstate') throw new Error('expected popstate');
    expect(typeof evt.url).toBe('string');
    expect(evt.state).toEqual({ a: 1, nested: { b: 2 } });
  });

  it('truncates oversize popstate state via the serializer', () => {
    const big = 'x'.repeat(20_000);
    dispatchPopstate({ huge: big });

    const evt = received[0]!;
    if (evt.subkind !== 'popstate') throw new Error('expected popstate');
    // serializeArgs replaces the oversize arg with a Truncated tag wrapper.
    expect(evt.state).not.toEqual({ huge: big });
    expect(JSON.stringify(evt.state).length).toBeLessThan(20_000);
  });

  it('history.pushState patch is transparent: event + history.length + location.pathname all advance', () => {
    const lengthBefore = history.length;

    history.pushState({ a: 1 }, '', '/smoke-x');

    expect(history.length).toBe(lengthBefore + 1);
    expect(location.pathname).toBe('/smoke-x');
    expect(received).toHaveLength(1);
    const evt = received[0]!;
    if (evt.subkind !== 'navigation') throw new Error('expected navigation');
    expect(evt.method).toBe('pushState');
    expect(evt.url.endsWith('/smoke-x')).toBe(true);
    expect(evt.state).toEqual({ a: 1 });
  });

  it('history.replaceState patch is transparent: event fires, location updates, history.length stable', () => {
    history.pushState({ seed: true }, '', '/seed');
    received.length = 0;
    const lengthBefore = history.length;

    history.replaceState({ b: 2 }, '', '/smoke-y');

    expect(history.length).toBe(lengthBefore);
    expect(location.pathname).toBe('/smoke-y');
    expect(received).toHaveLength(1);
    const evt = received[0]!;
    if (evt.subkind !== 'navigation') throw new Error('expected navigation');
    expect(evt.method).toBe('replaceState');
    expect(evt.url.endsWith('/smoke-y')).toBe(true);
    expect(evt.state).toEqual({ b: 2 });
  });

  it('disposer restores history.pushState/replaceState identity and removes listeners', () => {
    // Capture our wrapped references BEFORE dispose.
    const wrappedPush = history.pushState;
    const wrappedReplace = history.replaceState;

    dispose!();
    dispose = undefined;

    expect(history.pushState).not.toBe(wrappedPush);
    expect(history.replaceState).not.toBe(wrappedReplace);

    // Re-fire events after dispose: nothing should be captured.
    received.length = 0;
    dispatchPageTransition('pageshow', false);
    window.dispatchEvent(new Event('beforeunload'));
    document.dispatchEvent(new Event('visibilitychange'));
    history.pushState({ z: 9 }, '', '/post-dispose');
    expect(received).toHaveLength(0);
  });

  it('honors opts.enabled to selectively skip subkinds', () => {
    if (dispose) dispose();
    received = [];
    dispose = installLifecycleCapture((e) => received.push(e), FRAME, {
      enabled: { pageshow: false, navigation: false },
    });

    dispatchPageTransition('pageshow', false);
    history.pushState({ a: 1 }, '', '/skip');
    window.dispatchEvent(new Event('beforeunload'));

    // Only the beforeunload event should land.
    expect(received).toHaveLength(1);
    expect(received[0]!.subkind).toBe('beforeunload');
  });
});
