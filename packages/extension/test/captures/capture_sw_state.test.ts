import { describe, it, expect, vi } from 'vitest';
import {
  buildSwStateEvent,
  installSwStateCapture,
} from '../../src/captures/capture_sw_state.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';

const frame: FrameMeta = {
  frameUrl: 'https://app.example/',
  frameKey: 'top',
};

/** Build an EventTarget with extra props to stand in for SW DOM objects. */
const makeTarget = <T extends object>(props: T): T & EventTarget =>
  Object.assign(new EventTarget(), props);

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('buildSwStateEvent', () => {
  it('builds a frozen sw_state event with only present fields', () => {
    const e = buildSwStateEvent('statechange', frame, 123, {
      scriptURL: 'https://app.example/sw.js',
      state: 'activated',
      slot: 'active',
    });
    expect(e).toEqual({
      kind: 'sw_state',
      ts: 123,
      frameUrl: 'https://app.example/',
      frameKey: 'top',
      subkind: 'statechange',
      scriptURL: 'https://app.example/sw.js',
      state: 'activated',
      slot: 'active',
    });
    expect(Object.isFrozen(e)).toBe(true);
  });

  it('omits undefined optional fields', () => {
    const e = buildSwStateEvent('controllerchange', frame, 1, {});
    expect(e).toEqual({
      kind: 'sw_state',
      ts: 1,
      frameUrl: 'https://app.example/',
      frameKey: 'top',
      subkind: 'controllerchange',
    });
  });
});

describe('installSwStateCapture', () => {
  it('returns a no-op disposer when no container is available', () => {
    const emit = vi.fn();
    const dispose = installSwStateCapture(emit, frame, { container: null });
    dispose();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits controllerchange carrying the new controller', () => {
    const emit = vi.fn();
    const container = makeTarget({
      controller: { scriptURL: 'https://app.example/sw.js', state: 'activated' },
      getRegistrations: async () => [],
    });
    installSwStateCapture(emit, frame, {
      container: container as unknown as ServiceWorkerContainer,
      now: () => 7,
    });
    container.dispatchEvent(new Event('controllerchange'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      kind: 'sw_state',
      subkind: 'controllerchange',
      scriptURL: 'https://app.example/sw.js',
      state: 'activated',
      slot: 'active',
      ts: 7,
    });
  });

  it('emits updatefound and the ensuing worker statechange', async () => {
    const emit = vi.fn();
    const installing = makeTarget({
      scriptURL: 'https://app.example/sw.js?v=2',
      state: 'installing',
    });
    const reg = makeTarget({
      scope: 'https://app.example/',
      installing: null as unknown,
      waiting: null,
      active: null,
    });
    const container = makeTarget({
      controller: null,
      getRegistrations: async () => [reg],
    });
    installSwStateCapture(emit, frame, {
      container: container as unknown as ServiceWorkerContainer,
    });
    await flush(); // let getRegistrations().then wire the registration listeners

    (reg as { installing: unknown }).installing = installing;
    reg.dispatchEvent(new Event('updatefound'));
    installing.dispatchEvent(new Event('statechange'));

    const subkinds = emit.mock.calls.map((c) => c[0].subkind);
    expect(subkinds).toContain('updatefound');
    expect(subkinds).toContain('statechange');
    const statechange = emit.mock.calls
      .map((c) => c[0])
      .find((e) => e.subkind === 'statechange');
    expect(statechange).toMatchObject({
      scriptURL: 'https://app.example/sw.js?v=2',
      state: 'installing',
      slot: 'installing',
      scope: 'https://app.example/',
    });
  });

  it('disposer detaches listeners', () => {
    const emit = vi.fn();
    const container = makeTarget({
      controller: null,
      getRegistrations: async () => [],
    });
    const dispose = installSwStateCapture(emit, frame, {
      container: container as unknown as ServiceWorkerContainer,
    });
    dispose();
    container.dispatchEvent(new Event('controllerchange'));
    expect(emit).not.toHaveBeenCalled();
  });
});
