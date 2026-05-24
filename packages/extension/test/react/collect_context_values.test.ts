import { describe, it, expect } from 'vitest';
import { collectContextValues } from '../../src/react/collect_context_values.js';
import { REACT_CONTAINER_KEY_PREFIX } from '../../src/react/types.js';
import type { Fiber } from '../../src/react/types.js';

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

const PROVIDER = Symbol.for('react.provider');
const CONTEXT = Symbol.for('react.context');

// A React ≤18 Context provider fiber holding `value`.
const provider = (value: unknown, extra: Partial<Fiber> = {}): Fiber =>
  makeFiber({
    type: { $$typeof: PROVIDER, _context: {} },
    memoizedProps: { value },
    ...extra,
  });

// Wrap a top fiber under a HostRoot (tag 3) attached to a container-keyed element.
const rootEl = (top: Fiber): Element =>
  makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}abc`]: makeFiber({ tag: 3, child: top }) });

describe('collectContextValues', () => {
  it('returns [] when there are no React roots', () => {
    expect(collectContextValues(makeDoc([makeEl({ id: 'x' })]))).toEqual([]);
  });

  it('collects an object value held by a react.provider fiber', () => {
    const value = { store: { a: 1 } };
    expect(collectContextValues(makeDoc([rootEl(provider(value))]))).toEqual([
      value,
    ]);
  });

  it('collects React 19 context-as-provider ($$typeof react.context)', () => {
    const value = { k: 1 };
    const p = makeFiber({ type: { $$typeof: CONTEXT }, memoizedProps: { value } });
    expect(collectContextValues(makeDoc([rootEl(p)]))).toEqual([value]);
  });

  it('ignores non-provider fibers and non-object / non-provider values', () => {
    const objProvider = provider({ ok: true });
    const strProvider = provider('not-an-object', { child: objProvider });
    // A host 'div' carrying a value-shaped prop is NOT a context provider.
    const plainDiv = makeFiber({
      type: 'div',
      memoizedProps: { value: { ignored: true } },
      child: strProvider,
    });
    expect(collectContextValues(makeDoc([rootEl(plainDiv)]))).toEqual([
      { ok: true },
    ]);
  });

  it('de-dupes the same value object reachable from two providers', () => {
    const value = { shared: 1 };
    const p1 = provider(value, { child: provider(value) });
    expect(collectContextValues(makeDoc([rootEl(p1)]))).toEqual([value]);
  });

  it('walks multiple roots in document order', () => {
    const a = { r: 'a' };
    const b = { r: 'b' };
    expect(
      collectContextValues(makeDoc([rootEl(provider(a)), rootEl(provider(b))])),
    ).toEqual([a, b]);
  });
});
