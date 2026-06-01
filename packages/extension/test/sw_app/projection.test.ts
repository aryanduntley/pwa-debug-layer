import { describe, it, expect } from 'vitest';
import { projectServiceWorkerState } from '../../src/sw_app/projection.js';

/** Minimal fakes shaped to the structural WorkerLike/RegistrationLike inputs. */
const worker = (scriptURL: string, state: string) =>
  ({ scriptURL, state }) as never;

const reg = (over: Record<string, unknown>) =>
  ({
    scope: 'https://app.example/',
    updateViaCache: 'imports',
    installing: null,
    waiting: null,
    active: null,
    ...over,
  }) as never;

describe('projectServiceWorkerState', () => {
  it('reports unsupported with empty registrations', () => {
    const snap = projectServiceWorkerState([], null, false);
    expect(snap).toEqual({
      supported: false,
      controller: null,
      registrations: [],
      hasWaitingUpdate: false,
    });
  });

  it('defaults supported to true', () => {
    expect(projectServiceWorkerState([], null).supported).toBe(true);
  });

  it('projects an active worker + controller and derives activeScriptURL', () => {
    const snap = projectServiceWorkerState(
      [reg({ active: worker('https://app.example/sw.js', 'activated') })],
      worker('https://app.example/sw.js', 'activated'),
    );
    expect(snap.controller).toEqual({
      scriptURL: 'https://app.example/sw.js',
      state: 'activated',
    });
    expect(snap.registrations[0]!.active).toEqual({
      scriptURL: 'https://app.example/sw.js',
      state: 'activated',
    });
    expect(snap.registrations[0]!.activeScriptURL).toBe(
      'https://app.example/sw.js',
    );
    expect(snap.registrations[0]!.hasWaitingUpdate).toBe(false);
    expect(snap.hasWaitingUpdate).toBe(false);
  });

  it('flags hasWaitingUpdate when a waiting worker exists (the stuck-update case)', () => {
    const snap = projectServiceWorkerState(
      [
        reg({
          active: worker('https://app.example/sw.js', 'activated'),
          waiting: worker('https://app.example/sw.js?v=2', 'installed'),
        }),
      ],
      worker('https://app.example/sw.js', 'activated'),
    );
    expect(snap.registrations[0]!.hasWaitingUpdate).toBe(true);
    expect(snap.registrations[0]!.waiting).toEqual({
      scriptURL: 'https://app.example/sw.js?v=2',
      state: 'installed',
    });
    expect(snap.hasWaitingUpdate).toBe(true);
  });

  it('aggregates hasWaitingUpdate across multiple registrations', () => {
    const snap = projectServiceWorkerState(
      [
        reg({ scope: 'https://app.example/a/' }),
        reg({
          scope: 'https://app.example/b/',
          waiting: worker('https://app.example/b/sw.js', 'installed'),
        }),
      ],
      null,
    );
    expect(snap.registrations).toHaveLength(2);
    expect(snap.registrations[0]!.hasWaitingUpdate).toBe(false);
    expect(snap.registrations[1]!.hasWaitingUpdate).toBe(true);
    expect(snap.hasWaitingUpdate).toBe(true);
  });

  it('null active yields null activeScriptURL (first-load / installing only)', () => {
    const snap = projectServiceWorkerState(
      [reg({ installing: worker('https://app.example/sw.js', 'installing') })],
      null,
    );
    expect(snap.controller).toBeNull();
    expect(snap.registrations[0]!.active).toBeNull();
    expect(snap.registrations[0]!.activeScriptURL).toBeNull();
    expect(snap.registrations[0]!.installing).toEqual({
      scriptURL: 'https://app.example/sw.js',
      state: 'installing',
    });
  });

  it('falls back to updateViaCache=imports when absent', () => {
    const snap = projectServiceWorkerState(
      [{ scope: 'https://app.example/', installing: null, waiting: null, active: null } as never],
      null,
    );
    expect(snap.registrations[0]!.updateViaCache).toBe('imports');
  });
});
