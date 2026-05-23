import { describe, it, expect } from 'vitest';
import { discoverPiniaStores } from '../../../src/stores/pinia/discover.js';
import type { PiniaStore } from '../../../src/stores/pinia/detect.js';

const makeStore = (state: unknown): PiniaStore =>
  ({
    $state: state,
    $patch: () => undefined,
    $subscribe: () => () => undefined,
  }) as unknown as PiniaStore;

const makePinia = (entries: ReadonlyArray<readonly [string, unknown]>) => ({
  _s: new Map<string, unknown>(entries),
});

const makeApp = (pinia: unknown) => ({
  config: { globalProperties: { $pinia: pinia } },
});

// Minimal Document stand-in: findVueRoots only calls querySelectorAll('*') and
// reads el.__vue_app__, so an array of plain elements is sufficient.
const makeDoc = (els: ReadonlyArray<unknown>): Document =>
  ({ querySelectorAll: () => els }) as unknown as Document;

const elWithApp = (app: unknown) => ({ __vue_app__: app });

describe('discoverPiniaStores', () => {
  it('collects every Pinia-shaped store from a single app\'s $pinia._s registry', () => {
    const a = makeStore({ count: 1 });
    const b = makeStore({ todos: [] });
    const doc = makeDoc([
      elWithApp(makeApp(makePinia([['counter', a], ['todos', b]]))),
    ]);
    expect(discoverPiniaStores(doc)).toEqual([a, b]);
  });

  it('de-dupes a Pinia instance shared across multiple mount roots', () => {
    const a = makeStore({ count: 1 });
    const pinia = makePinia([['counter', a]]);
    // Two roots, both using app.use(pinia) with the SAME pinia instance.
    const doc = makeDoc([elWithApp(makeApp(pinia)), elWithApp(makeApp(pinia))]);
    expect(discoverPiniaStores(doc)).toEqual([a]);
  });

  it('scans distinct Pinia instances across separate apps', () => {
    const a = makeStore({ count: 1 });
    const b = makeStore({ count: 2 });
    const doc = makeDoc([
      elWithApp(makeApp(makePinia([['a', a]]))),
      elWithApp(makeApp(makePinia([['b', b]]))),
    ]);
    expect(discoverPiniaStores(doc)).toEqual([a, b]);
  });

  it('filters out non-Pinia-shaped entries in the registry', () => {
    const good = makeStore({ ok: true });
    const doc = makeDoc([
      elWithApp(
        makeApp(
          makePinia([
            ['good', good],
            ['bad', { setState: () => undefined }],
            ['nope', 42],
          ]),
        ),
      ),
    ]);
    expect(discoverPiniaStores(doc)).toEqual([good]);
  });

  it('returns [] when an app exposes no $pinia', () => {
    const doc = makeDoc([elWithApp({ config: { globalProperties: {} } })]);
    expect(discoverPiniaStores(doc)).toEqual([]);
  });

  it('returns [] when $pinia._s is not a Map', () => {
    const doc = makeDoc([elWithApp(makeApp({ _s: { counter: makeStore({}) } }))]);
    expect(discoverPiniaStores(doc)).toEqual([]);
  });

  it('skips elements without a __vue_app__ and returns [] for none', () => {
    expect(discoverPiniaStores(makeDoc([{}, { foo: 1 }]))).toEqual([]);
  });
});
