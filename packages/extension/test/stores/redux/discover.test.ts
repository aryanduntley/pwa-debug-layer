import { describe, it, expect } from 'vitest';
import { discoverReduxStores } from '../../../src/stores/redux/discover.js';
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

const reduxLike = (state: unknown) => ({
  getState: () => state,
  subscribe: () => () => undefined,
  dispatch: (a: { type: string }) => a,
});

describe('discoverReduxStores', () => {
  it('returns [] when there are no React roots', () => {
    expect(discoverReduxStores(makeDoc([makeEl({ id: 'x' })]))).toEqual([]);
  });

  it('extracts the store from a react-redux context value { store }', () => {
    const store = reduxLike({ a: 1 });
    const found = discoverReduxStores(makeDoc([rootEl(provider({ store }))]));
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(store);
    expect(found[0]?.getState()).toEqual({ a: 1 });
  });

  it('accepts a redux-shaped object held directly as the context value', () => {
    const store = reduxLike({ b: 2 });
    const found = discoverReduxStores(makeDoc([rootEl(provider(store))]));
    expect(found).toEqual([store]);
  });

  it('ignores context values that are neither { store } nor redux-shaped', () => {
    const notAStore = provider({ theme: 'dark' });
    expect(discoverReduxStores(makeDoc([rootEl(notAStore)]))).toEqual([]);
  });

  it('rejects a { store } whose store fails the duck-type (missing dispatch)', () => {
    const partial = { store: { getState: () => ({}), subscribe: () => () => undefined } };
    expect(discoverReduxStores(makeDoc([rootEl(provider(partial))]))).toEqual([]);
  });

  it('de-dupes the same store reachable from two providers', () => {
    const store = reduxLike({ n: 1 });
    const top = provider({ store }, { child: provider({ store }) });
    expect(discoverReduxStores(makeDoc([rootEl(top)]))).toEqual([store]);
  });
});
