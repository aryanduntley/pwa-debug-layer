/**
 * Pure projection of the debugged page's live service-worker registrations +
 * controller into the wire-safe `SwStatusSnapshot`. No `navigator.*` reads here
 * — the edge dispatcher (page-world `sw_status` handler) reads the live objects
 * and hands them in, so this stays pure and unit-testable with plain fakes.
 *
 * This is the DEBUGGED PWA's service worker, distinct from the extension's own
 * `sw_lifecycle` module (which captures SW-side page-navigation lifecycle).
 */

import type {
  SwStatusSnapshot,
  SwRegistrationRecord,
  SwWorkerRecord,
  SwWorkerState,
  SwUpdateViaCache,
} from '@pwa-debug/shared';

/**
 * Minimal structural view of a DOM `ServiceWorker` we read. The real
 * `ServiceWorker` (and our test fakes) are assignable to this — structural
 * typing lets us avoid depending on the DOM lib here.
 */
type WorkerLike = {
  readonly scriptURL: string;
  readonly state: SwWorkerState;
};

/** Minimal structural view of a DOM `ServiceWorkerRegistration` we read. */
type RegistrationLike = {
  readonly scope: string;
  readonly updateViaCache?: SwUpdateViaCache;
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  readonly active: WorkerLike | null;
};

const projectWorker = (worker: WorkerLike | null): SwWorkerRecord | null =>
  worker === null
    ? null
    : { scriptURL: worker.scriptURL, state: worker.state };

const projectRegistration = (reg: RegistrationLike): SwRegistrationRecord => {
  const active = projectWorker(reg.active);
  return {
    scope: reg.scope,
    updateViaCache: reg.updateViaCache ?? 'imports',
    installing: projectWorker(reg.installing),
    waiting: projectWorker(reg.waiting),
    active,
    activeScriptURL: active === null ? null : active.scriptURL,
    hasWaitingUpdate: reg.waiting !== null,
  };
};

/**
 * Project live registrations + controller into a `SwStatusSnapshot`.
 *
 * @param registrations result of `navigator.serviceWorker.getRegistrations()`
 * @param controller    `navigator.serviceWorker.controller`
 * @param supported     whether `navigator.serviceWorker` exists (default true)
 */
export const projectServiceWorkerState = (
  registrations: readonly RegistrationLike[],
  controller: WorkerLike | null,
  supported = true,
): SwStatusSnapshot => {
  const projected = registrations.map(projectRegistration);
  return {
    supported,
    controller: projectWorker(controller),
    registrations: projected,
    hasWaitingUpdate: projected.some((reg) => reg.hasWaitingUpdate),
  };
};
