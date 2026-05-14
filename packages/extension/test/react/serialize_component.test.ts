import { describe, it, expect } from 'vitest';
import { serializeComponent } from '../../src/react/serialize_component.js';
import type { Fiber } from '../../src/react/types.js';

const HOST_ROOT_TAG = 3;
const FUNCTION_COMPONENT_TAG = 0;
const CLASS_COMPONENT_TAG = 1;
const FORWARD_REF_TAG = 11;
const HOST_COMPONENT_TAG = 5;

const f = (overrides: Partial<Fiber>): Fiber =>
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

const link = (parent: Fiber, children: Fiber[]): void => {
  if (children.length === 0) return;
  (parent as { child: Fiber | null }).child = children[0]!;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    (c as { return: Fiber | null }).return = parent;
    (c as { sibling: Fiber | null }).sibling = children[i + 1] ?? null;
  }
};

const composite = (tag: number, name: string, overrides: Partial<Fiber> = {}): Fiber =>
  f({ tag, type: { displayName: name }, ...overrides });

describe('serializeComponent', () => {
  it('returns stableId + displayName for a minimal function component', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = composite(FUNCTION_COMPONENT_TAG, 'App');
    link(root, [app]);

    const info = serializeComponent(app);
    expect(info.stableId).toBe('root0/App[0]');
    expect(info.displayName).toBe('App');
  });

  it("omits the 'key' field when the fiber has no key", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = composite(FUNCTION_COMPONENT_TAG, 'App');
    link(root, [app]);

    const info = serializeComponent(app);
    expect('key' in info).toBe(false);
  });

  it("includes the 'key' field when set", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const t = composite(FUNCTION_COMPONENT_TAG, 'Todo', { key: 'todo-42' });
    link(root, [t]);

    const info = serializeComponent(t);
    expect(info.key).toBe('todo-42');
  });

  it("includes 'props' when memoizedProps is set and includeProps defaults true", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const c = composite(FUNCTION_COMPONENT_TAG, 'Counter', {
      memoizedProps: { initial: 0, step: 1 },
    });
    link(root, [c]);

    const info = serializeComponent(c);
    expect(info.props).toEqual({ initial: 0, step: 1 });
  });

  it("omits 'props' when includeProps:false", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const c = composite(FUNCTION_COMPONENT_TAG, 'Counter', {
      memoizedProps: { initial: 0 },
    });
    link(root, [c]);

    const info = serializeComponent(c, 0, { includeProps: false });
    expect('props' in info).toBe(false);
  });

  it("includes 'state' for ClassComponent and OMITS it for FunctionComponent", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const classApp = composite(CLASS_COMPONENT_TAG, 'ClassApp', {
      memoizedState: { count: 5 },
    });
    const fnApp = composite(FUNCTION_COMPONENT_TAG, 'FnApp', {
      memoizedState: { ignored: true },
    });
    link(root, [classApp, fnApp]);

    const classInfo = serializeComponent(classApp);
    const fnInfo = serializeComponent(fnApp);
    expect(classInfo.state).toEqual({ count: 5 });
    expect('state' in fnInfo).toBe(false);
  });

  it("includes 'hooks' for tag 0/11/14 (function/forwardRef/memo) and OMITS for class/host", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const fnComp = composite(FUNCTION_COMPONENT_TAG, 'Fn', {
      memoizedState: { memoizedState: 1, queue: { dispatch: () => undefined }, next: null },
    });
    const fwd = composite(FORWARD_REF_TAG, 'Fwd', {
      memoizedState: { memoizedState: 2, queue: { dispatch: () => undefined }, next: null },
    });
    const classComp = composite(CLASS_COMPONENT_TAG, 'Cls', {
      memoizedState: { count: 0 },
    });
    const host = f({ tag: HOST_COMPONENT_TAG, type: 'div' });
    link(root, [fnComp, fwd, classComp, host]);

    expect(serializeComponent(fnComp).hooks).toHaveLength(1);
    expect(serializeComponent(fwd).hooks).toHaveLength(1);
    expect('hooks' in serializeComponent(classComp)).toBe(false);
    expect('hooks' in serializeComponent(host)).toBe(false);
  });

  it("omits 'hooks' when includeHooks:false even for a function component", () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const c = composite(FUNCTION_COMPONENT_TAG, 'Counter', {
      memoizedState: { memoizedState: 42, queue: { dispatch: () => undefined }, next: null },
    });
    link(root, [c]);

    const info = serializeComponent(c, 0, { includeHooks: false });
    expect('hooks' in info).toBe(false);
  });

  it('rolls up truncation from props into top-level truncated:true', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const huge = { big: 'x'.repeat(20000) };
    const c = composite(FUNCTION_COMPONENT_TAG, 'BigProps', { memoizedProps: huge });
    link(root, [c]);

    const info = serializeComponent(c);
    expect(info.truncated).toBe(true);
  });

  it('rolls up truncation from a hook value into top-level truncated:true', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const big = 'x'.repeat(20000);
    const c = composite(FUNCTION_COMPONENT_TAG, 'BigState', {
      memoizedState: { memoizedState: big, queue: { dispatch: () => undefined }, next: null },
    });
    link(root, [c]);

    const info = serializeComponent(c);
    expect(info.truncated).toBe(true);
  });

  it('does NOT set truncated when nothing was truncated', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const c = composite(FUNCTION_COMPONENT_TAG, 'Small', {
      memoizedProps: { a: 1 },
    });
    link(root, [c]);

    const info = serializeComponent(c);
    expect('truncated' in info).toBe(false);
  });

  it('uses the supplied rootIndex in the stableId', () => {
    const root = f({ tag: HOST_ROOT_TAG });
    const app = composite(FUNCTION_COMPONENT_TAG, 'App');
    link(root, [app]);

    const info = serializeComponent(app, 3);
    expect(info.stableId.startsWith('root3')).toBe(true);
  });
});
