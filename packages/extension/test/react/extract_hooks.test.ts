import { describe, it, expect } from 'vitest';
import { extractHooks } from '../../src/react/extract_hooks.js';
import type { Fiber } from '../../src/react/types.js';

type HookNode = {
  memoizedState: unknown;
  queue: unknown;
  next: HookNode | null;
};

const makeFiber = (memoizedState: unknown): Fiber =>
  ({
    type: null,
    elementType: null,
    tag: 0,
    key: null,
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: null,
    memoizedState,
  }) as Fiber;

const chain = (...nodes: Omit<HookNode, 'next'>[]): HookNode | null => {
  if (nodes.length === 0) return null;
  const linked = nodes.map((n) => ({ ...n, next: null }) as HookNode);
  for (let i = 0; i < linked.length - 1; i++) {
    linked[i]!.next = linked[i + 1]!;
  }
  return linked[0]!;
};

const stateNode = (value: unknown): Omit<HookNode, 'next'> => ({
  memoizedState: value,
  queue: { dispatch: () => undefined, lastRenderedState: value },
});

const effectNode = (deps: unknown): Omit<HookNode, 'next'> => ({
  memoizedState: {
    tag: 1,
    create: () => undefined,
    destroy: undefined,
    deps,
  },
  queue: null,
});

const memoNode = (value: unknown, deps: unknown[]): Omit<HookNode, 'next'> => ({
  memoizedState: [value, deps],
  queue: null,
});

const refNode = (current: unknown): Omit<HookNode, 'next'> => ({
  memoizedState: { current },
  queue: null,
});

const customNode = (value: unknown): Omit<HookNode, 'next'> => ({
  memoizedState: value,
  queue: null,
});

describe('extractHooks', () => {
  it('returns [] when fiber has no memoizedState', () => {
    expect(extractHooks(makeFiber(null))).toEqual([]);
  });

  it('returns [] when memoizedState is not a hook-shaped node', () => {
    expect(extractHooks(makeFiber({ class: 'state', nope: true }))).toEqual([]);
  });

  it('classifies a useState hook as type="state" with the value preserved', () => {
    const hooks = extractHooks(makeFiber(chain(stateNode(42))));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ type: 'state', index: 0, value: 42 });
  });

  it('assigns 0,1,2 indices across a chain of state hooks', () => {
    const hooks = extractHooks(
      makeFiber(chain(stateNode('a'), stateNode('b'), stateNode('c'))),
    );
    expect(hooks.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(hooks.map((h) => h.value)).toEqual(['a', 'b', 'c']);
  });

  it('classifies a useEffect-shaped node as type="effect" with deps and no value', () => {
    const hooks = extractHooks(makeFiber(chain(effectNode(['x', 1]))));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ type: 'effect', deps: ['x', 1] });
    expect(hooks[0]).not.toHaveProperty('value');
  });

  it('classifies a useMemo-shaped tuple as type="memo" with value and deps', () => {
    const hooks = extractHooks(makeFiber(chain(memoNode(100, ['dep1', 'dep2']))));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      type: 'memo',
      value: 100,
      deps: ['dep1', 'dep2'],
    });
  });

  it('classifies a useRef-shaped node as type="ref" with value === current', () => {
    const ref = { custom: 'thing' };
    const hooks = extractHooks(makeFiber(chain(refNode(ref))));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ type: 'ref' });
    expect((hooks[0]?.value as { custom: string }).custom).toBe('thing');
  });

  it('falls back to type="custom" for an unrecognized shape', () => {
    const hooks = extractHooks(makeFiber(chain(customNode('mystery'))));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ type: 'custom', value: 'mystery' });
  });

  it('handles a mixed chain of all hook types', () => {
    const hooks = extractHooks(
      makeFiber(
        chain(
          stateNode(0),
          memoNode('m', [1]),
          refNode({ current: 'r' }),
          effectNode([]),
          customNode({ x: 1 }),
        ),
      ),
    );
    expect(hooks.map((h) => h.type)).toEqual([
      'state',
      'memo',
      'ref',
      'effect',
      'custom',
    ]);
    expect(hooks.map((h) => h.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('does not classify ref when the object has fields besides current', () => {
    const hooks = extractHooks(
      makeFiber(chain(customNode({ current: 'x', other: 'y' }))),
    );
    expect(hooks[0]?.type).toBe('custom');
  });

  it('sets truncated:true when value exceeds the 16KB serializer cap', () => {
    const huge = { big: 'x'.repeat(20000) };
    const hooks = extractHooks(makeFiber(chain(stateNode(huge))));
    expect(hooks[0]?.truncated).toBe(true);
  });

  it('handles a queue-only state hook with undefined memoizedState', () => {
    const node: Omit<HookNode, 'next'> = {
      memoizedState: undefined,
      queue: { dispatch: () => undefined },
    };
    const hooks = extractHooks(makeFiber(chain(node)));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.type).toBe('state');
  });
});
