import type { Disposer, FrameMeta } from './capture_console.js';
import type { LifecycleCapturedEvent } from './types.js';

export type CsLifecycleCaptureOptions = {
  readonly enabled?: {
    readonly pagehide?: boolean;
  };
};

export type CsLifecycleCaptureInput = {
  readonly frame: FrameMeta;
  readonly send: (event: LifecycleCapturedEvent) => void;
  readonly opts?: CsLifecycleCaptureOptions;
};

const NOOP_DISPOSER: Disposer = () => {};

export const installCsLifecycleCapture = (
  input: CsLifecycleCaptureInput,
): Disposer => {
  if (typeof window === 'undefined') {
    return NOOP_DISPOSER;
  }

  const { frame, send, opts } = input;
  if (opts?.enabled?.pagehide === false) {
    return NOOP_DISPOSER;
  }

  let disposed = false;

  const onPagehide = (e: Event): void => {
    if (disposed) return;
    const persisted = (e as PageTransitionEvent).persisted ?? false;
    const event: LifecycleCapturedEvent = Object.freeze({
      kind: 'lifecycle',
      source: 'cs',
      subkind: 'pagehide',
      persisted,
      ts: Date.now(),
      frameUrl: frame.frameUrl,
      frameKey: frame.frameKey,
    }) as LifecycleCapturedEvent;
    try {
      send(event);
    } catch {
      // CS-side send failures must never break the page.
    }
  };

  window.addEventListener('pagehide', onPagehide);

  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', onPagehide);
  };
};
