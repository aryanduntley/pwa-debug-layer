import type { Disposer, FrameMeta } from './capture_console.js';
import { serializeArgs } from './serialize.js';
import type {
  LifecycleCapturedEvent,
  LifecycleCaptureOptions,
  PageLifecyclePayload,
  PageLifecycleSubkind,
} from './types.js';

const isEnabled = (
  opts: LifecycleCaptureOptions | undefined,
  subkind: PageLifecycleSubkind,
): boolean => opts?.enabled?.[subkind] !== false;

const serializeState = (state: unknown): unknown => {
  const { serialized } = serializeArgs([state]);
  return serialized[0];
};

export const installLifecycleCapture = (
  emit: (event: LifecycleCapturedEvent) => void,
  frame: FrameMeta,
  opts?: LifecycleCaptureOptions,
): Disposer => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const now = (): number => Date.now();
  let disposed = false;
  const cleanups: Array<() => void> = [];

  const tryEmit = (event: LifecycleCapturedEvent): void => {
    if (disposed) return;
    try {
      emit(event);
    } catch {
      // Capture failure must never break the page.
    }
  };

  const buildEvent = (payload: PageLifecyclePayload): LifecycleCapturedEvent =>
    Object.freeze({
      kind: 'lifecycle',
      source: 'page',
      ts: now(),
      frameUrl: frame.frameUrl,
      frameKey: frame.frameKey,
      ...payload,
    }) as LifecycleCapturedEvent;

  if (isEnabled(opts, 'pageshow')) {
    const onPageshow = (e: Event): void => {
      const persisted = (e as PageTransitionEvent).persisted ?? false;
      tryEmit(buildEvent({ subkind: 'pageshow', persisted }));
    };
    window.addEventListener('pageshow', onPageshow);
    cleanups.push(() => window.removeEventListener('pageshow', onPageshow));
  }

  if (isEnabled(opts, 'pagehide')) {
    const onPagehide = (e: Event): void => {
      const persisted = (e as PageTransitionEvent).persisted ?? false;
      tryEmit(buildEvent({ subkind: 'pagehide', persisted }));
    };
    window.addEventListener('pagehide', onPagehide);
    cleanups.push(() => window.removeEventListener('pagehide', onPagehide));
  }

  if (isEnabled(opts, 'visibilitychange')) {
    const onVisibility = (): void => {
      const visibilityState: 'visible' | 'hidden' =
        document.visibilityState === 'visible' ? 'visible' : 'hidden';
      tryEmit(buildEvent({ subkind: 'visibilitychange', visibilityState }));
    };
    document.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() =>
      document.removeEventListener('visibilitychange', onVisibility),
    );
  }

  if (isEnabled(opts, 'beforeunload')) {
    const onBeforeunload = (): void => {
      tryEmit(buildEvent({ subkind: 'beforeunload' }));
    };
    window.addEventListener('beforeunload', onBeforeunload);
    cleanups.push(() =>
      window.removeEventListener('beforeunload', onBeforeunload),
    );
  }

  if (isEnabled(opts, 'popstate')) {
    const onPopstate = (e: Event): void => {
      const popEvent = e as PopStateEvent;
      tryEmit(
        buildEvent({
          subkind: 'popstate',
          url: location.href,
          state: serializeState(popEvent.state),
        }),
      );
    };
    window.addEventListener('popstate', onPopstate);
    cleanups.push(() => window.removeEventListener('popstate', onPopstate));
  }

  if (isEnabled(opts, 'navigation') && typeof history !== 'undefined') {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    const wrap = (
      method: 'pushState' | 'replaceState',
      original: History['pushState'],
    ): History['pushState'] =>
      function patched(
        this: History,
        state: unknown,
        title: string,
        url?: string | URL | null,
      ): void {
        original.call(this, state, title, url ?? null);
        const navPayload: PageLifecyclePayload = {
          subkind: 'navigation',
          method,
          url: location.href,
          ...(title ? { title } : {}),
          state: serializeState(state),
        };
        tryEmit(buildEvent(navPayload));
      };

    const ourPushState = wrap('pushState', originalPushState);
    const ourReplaceState = wrap('replaceState', originalReplaceState);
    history.pushState = ourPushState;
    history.replaceState = ourReplaceState;

    cleanups.push(() => {
      if (history.pushState === ourPushState) {
        history.pushState = originalPushState;
      }
      if (history.replaceState === ourReplaceState) {
        history.replaceState = originalReplaceState;
      }
    });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Ignore cleanup failures.
      }
    }
  };
};
