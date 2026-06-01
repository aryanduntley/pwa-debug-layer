/**
 * Page-world capture producer for the DEBUGGED PWA's service-worker lifecycle.
 *
 * Subscribes to navigator.serviceWorker and emits a typed SwStateCapturedEvent
 * (kind 'sw_state') on each transition — a new worker installing (updatefound),
 * a worker advancing state (statechange), or the page's controller changing
 * (controllerchange). Feeds the existing capture pipeline (page → CS → SW →
 * host ring buffer), tailed by the sw_lifecycle_tail MCP tool.
 *
 * This is the APP's service worker (navigator.serviceWorker), distinct from the
 * extension's own sw_lifecycle module (which emits page-navigation events).
 */

import type { SwStateCapturedEvent, SwStateSubkind } from './types.js';
import type { SwWorkerState } from '@pwa-debug/shared';
import type { Disposer, FrameMeta } from './capture_console.js';

type SwStateSlot = 'installing' | 'waiting' | 'active';

type SwStateFields = {
  readonly scope?: string;
  readonly scriptURL?: string;
  readonly state?: SwWorkerState;
  readonly slot?: SwStateSlot;
};

/** Pure builder: frame meta + ts + subkind + the present optional fields. */
export const buildSwStateEvent = (
  subkind: SwStateSubkind,
  frame: FrameMeta,
  ts: number,
  fields: SwStateFields,
): SwStateCapturedEvent =>
  Object.freeze({
    kind: 'sw_state' as const,
    ts,
    frameUrl: frame.frameUrl,
    frameKey: frame.frameKey,
    ...(frame.isCrossOrigin !== undefined
      ? { isCrossOrigin: frame.isCrossOrigin }
      : {}),
    subkind,
    ...(fields.scope !== undefined ? { scope: fields.scope } : {}),
    ...(fields.scriptURL !== undefined ? { scriptURL: fields.scriptURL } : {}),
    ...(fields.state !== undefined ? { state: fields.state } : {}),
    ...(fields.slot !== undefined ? { slot: fields.slot } : {}),
  });

export type SwStateCaptureOptions = {
  /** Inject a container for tests; defaults to navigator.serviceWorker. */
  readonly container?: ServiceWorkerContainer | null;
  readonly now?: () => number;
};

export const installSwStateCapture = (
  emit: (event: SwStateCapturedEvent) => void,
  frame: FrameMeta,
  opts?: SwStateCaptureOptions,
): Disposer => {
  const container =
    opts?.container !== undefined
      ? opts.container
      : (((navigator as Navigator).serviceWorker as
          | ServiceWorkerContainer
          | undefined) ?? null);
  const now = opts?.now ?? (() => Date.now());

  if (container === null || typeof container.addEventListener !== 'function') {
    return () => {};
  }

  const cleanups: Array<() => void> = [];
  const listen = (
    target: EventTarget,
    type: string,
    handler: () => void,
  ): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  const safeEmit = (subkind: SwStateSubkind, fields: SwStateFields): void => {
    try {
      emit(buildSwStateEvent(subkind, frame, now(), fields));
    } catch {
      // Capture failure must never break the page.
    }
  };

  const watchWorker = (
    worker: ServiceWorker | null,
    scope: string | undefined,
    slot: SwStateSlot,
  ): void => {
    if (worker === null) return;
    listen(worker, 'statechange', () => {
      safeEmit('statechange', {
        ...(scope !== undefined ? { scope } : {}),
        scriptURL: worker.scriptURL,
        state: worker.state,
        slot,
      });
    });
  };

  const watchRegistration = (reg: ServiceWorkerRegistration): void => {
    listen(reg, 'updatefound', () => {
      const installing = reg.installing;
      safeEmit('updatefound', {
        scope: reg.scope,
        ...(installing !== null
          ? { scriptURL: installing.scriptURL, state: installing.state }
          : {}),
        slot: 'installing',
      });
      // The just-appeared installing worker drives the install→activated chain.
      watchWorker(installing, reg.scope, 'installing');
    });
    // Attach to any workers already in flight so an in-progress install/activate
    // isn't missed (the snapshot is sw_status; this is the forward stream).
    watchWorker(reg.installing, reg.scope, 'installing');
    watchWorker(reg.waiting, reg.scope, 'waiting');
    watchWorker(reg.active, reg.scope, 'active');
  };

  listen(container, 'controllerchange', () => {
    const controller = container.controller;
    safeEmit('controllerchange', {
      ...(controller !== null
        ? { scriptURL: controller.scriptURL, state: controller.state }
        : {}),
      slot: 'active',
    });
  });

  if (typeof container.getRegistrations === 'function') {
    container
      .getRegistrations()
      .then((regs) => {
        for (const reg of regs) watchRegistration(reg);
      })
      .catch(() => {
        // No registrations / API failure — controllerchange stays wired.
      });
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
  };
};
