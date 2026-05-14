export const REACT_FIBER_KEY_PREFIX = '__reactFiber$';
export const REACT_CONTAINER_KEY_PREFIX = '__reactContainer$';

export type Fiber = {
  type: unknown;
  elementType: unknown;
  tag: number;
  key: string | null;
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
};
