import { describe, it, expect } from 'vitest';
import { getRootFiber } from '../../src/react/get_root_fiber.js';
import {
  REACT_CONTAINER_KEY_PREFIX,
  REACT_FIBER_KEY_PREFIX,
} from '../../src/react/types.js';
import type { Fiber } from '../../src/react/types.js';

const HOST_ROOT_TAG = 3;

const f = (overrides: Partial<Fiber> = {}): Fiber =>
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
    ...overrides,
  }) as Fiber;

const makeEl = (props: Record<string, unknown>): Element => {
  const el = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(props)) el[k] = v;
  return el as unknown as Element;
};

// DOM-like fake exposing querySelectorAll so the descendant-fiber strategy
// can be exercised (synthetic makeEl objects have no querySelectorAll and so
// skip that strategy entirely).
const makeDomEl = (
  ownProps: Record<string, unknown>,
  descendants: Array<Record<string, unknown>>,
): Element => {
  const el = { ...ownProps } as Record<string, unknown>;
  el['querySelectorAll'] = () =>
    descendants.map((d) => {
      const node = {} as Record<string, unknown>;
      for (const [k, v] of Object.entries(d)) node[k] = v;
      return node as unknown as Element;
    });
  return el as unknown as Element;
};

describe('getRootFiber', () => {
  it('returns the HostRoot fiber when container exposes __reactContainer$ with .current', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const fiberRoot = { current: root };
    const el = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}abc`]: fiberRoot });
    expect(getRootFiber(el)).toBe(root);
  });

  it("falls back to __reactFiber$ when no __reactContainer$ is present", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const el = makeEl({ [`${REACT_FIBER_KEY_PREFIX}xyz`]: root });
    expect(getRootFiber(el)).toBe(root);
  });

  it('prefers __reactContainer$ over __reactFiber$ when both are present', () => {
    const containerRoot = f({ tag: HOST_ROOT_TAG });
    const fiberRoot = { current: containerRoot };
    const decoy = f({ tag: HOST_ROOT_TAG });
    const el = makeEl({
      [`${REACT_CONTAINER_KEY_PREFIX}c`]: fiberRoot,
      [`${REACT_FIBER_KEY_PREFIX}f`]: decoy,
    });
    expect(getRootFiber(el)).toBe(containerRoot);
  });

  it('climbs to the HostRoot when the resolved fiber is a descendant', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const child = f({ tag: 0 });
    (child as { return: Fiber | null }).return = root;
    const el = makeEl({ [`${REACT_FIBER_KEY_PREFIX}x`]: child });
    expect(getRootFiber(el)).toBe(root);
  });

  it('returns undefined when no HostRoot ancestor exists', () => {
    const stray = f({ tag: 0 });
    const el = makeEl({ [`${REACT_FIBER_KEY_PREFIX}x`]: stray });
    expect(getRootFiber(el)).toBeUndefined();
  });

  it('returns undefined when the container value is null', () => {
    const el = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}c`]: null });
    expect(getRootFiber(el)).toBeUndefined();
  });

  it('returns undefined when __reactContainer$ has no .current', () => {
    const el = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}c`]: {} });
    expect(getRootFiber(el)).toBeUndefined();
  });

  it('returns undefined when the element carries no fiber or container keys', () => {
    const el = makeEl({ id: 'plain' });
    expect(getRootFiber(el)).toBeUndefined();
  });

  it('resolves the committed HostRoot when __reactContainer$ is the HostRoot fiber itself (React 18 createRoot)', () => {
    // React 18 createRoot attaches the HostRoot fiber (tag 3) directly under
    // __reactContainer$*, and it is the double-buffered alternate with no
    // child. The committed tree lives at fiber.stateNode.current.
    const committed = f({ tag: HOST_ROOT_TAG, child: f({ tag: 0 }) });
    const fiberRoot = { current: committed };
    const attached = f({
      tag: HOST_ROOT_TAG,
      child: null,
      stateNode: fiberRoot as unknown as Fiber['stateNode'],
    });
    const el = makeEl({ [`${REACT_CONTAINER_KEY_PREFIX}opdn`]: attached });
    expect(getRootFiber(el)).toBe(committed);
  });

  it('prefers a child-bearing HostRoot from a descendant fiber over a childless container root', () => {
    // Container strategy yields a childless (known-defective) HostRoot; the
    // descendant host-node fiber climbs to a real, child-bearing HostRoot —
    // getRootFiber must discard the empty one and use the good one.
    const childlessRoot = f({ tag: HOST_ROOT_TAG, child: null });
    const goodRoot = f({ tag: HOST_ROOT_TAG, child: f({ tag: 0 }) });
    const hostChild = f({ tag: 5, return: goodRoot });
    const el = makeDomEl(
      { [`${REACT_CONTAINER_KEY_PREFIX}c`]: { current: childlessRoot } },
      [{ [`${REACT_FIBER_KEY_PREFIX}h`]: hostChild }],
    );
    expect(getRootFiber(el)).toBe(goodRoot);
  });
});
