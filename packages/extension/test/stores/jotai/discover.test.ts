import { describe, it, expect } from 'vitest';
import { discoverJotaiStores } from '../../../src/stores/jotai/discover.js';
import { REACT_CONTAINER_KEY_PREFIX } from '../../../src/react/types.js';
import type { Fiber } from '../../../src/react/types.js';

const makeFiber = (o: Partial<Fiber> = {}): Fiber =>
  ({
    type: null,
    elementType: null,
    tag: 5,
    key: null,
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: null,
    memoizedState: null,
    ...o,
  }) as Fiber;

const makeEl = (props: Record<string, unknown>): Element => {
  const el = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(props)) el[k] = v;
  return el as unknown as Element;
};

const makeDoc = (els: Element[]): Document =>
  ({
    querySelectorAll: (sel: string): ArrayLike<Element> => {
      if (sel !== '*') throw new Error(`unexpected selector ${sel}`);
      return els;
    },
  }) as unknown as Document;

const provider = (value: unknown, extra: Partial<Fiber> = {}): Fiber =>
  makeFiber({
    type: { $$typeof: Symbol.for('react.provider'), _context: {} },
    memoizedProps: { value },
    ...extra,
  });

const rootEl = (top: Fiber): Element =>
  makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}abc`]: makeFiber({ tag: 3, child: top }) });

// Jotai's Provider context value IS the createStore() instance ({get,set,sub}).
const jotaiStore = () => ({
  get: () => undefined,
  set: () => undefined,
  sub: () => () => undefined,
});

describe('discoverJotaiStores', () => {
  it('returns [] when there are no React roots', () => {
    expect(discoverJotaiStores(makeDoc([makeEl({ id: 'x' })]))).toEqual([]);
  });

  it('finds a Jotai store held directly as the Provider context value', () => {
    const store = jotaiStore();
    const found = discoverJotaiStores(makeDoc([rootEl(provider(store))]));
    expect(found).toEqual([store]);
  });

  it('ignores context values that are not Jotai-shaped', () => {
    // react-redux's { store } wrapper and a plain object are both skipped.
    const reduxCtx = provider({ store: { getState() {}, subscribe() {}, dispatch() {} } });
    const plain = provider({ theme: 'dark' });
    expect(
      discoverJotaiStores(makeDoc([rootEl(provider(undefined, { child: reduxCtx })), rootEl(plain)])),
    ).toEqual([]);
  });

  it('de-dupes the same store reachable from two providers', () => {
    const store = jotaiStore();
    const top = provider(store, { child: provider(store) });
    expect(discoverJotaiStores(makeDoc([rootEl(top)]))).toEqual([store]);
  });
});
