import { describe, it, expect } from 'vitest';
import { extractDisplayName } from '../../src/react/extract_display_name.js';
import type { Fiber } from '../../src/react/types.js';

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

describe('extractDisplayName', () => {
  it("returns 'HostRoot' for tag 3", () => {
    expect(extractDisplayName(f({ tag: 3 }))).toBe('HostRoot');
  });

  it('returns the host tag name for tag 5 (HostComponent) when type is a string', () => {
    expect(extractDisplayName(f({ tag: 5, type: 'div' }))).toBe('div');
    expect(extractDisplayName(f({ tag: 5, type: 'span' }))).toBe('span');
  });

  it("falls back to 'HostComponent' for tag 5 when type is not a string", () => {
    expect(extractDisplayName(f({ tag: 5, type: null }))).toBe('HostComponent');
  });

  it("returns 'Text' for tag 6 (HostText)", () => {
    expect(extractDisplayName(f({ tag: 6 }))).toBe('Text');
  });

  it("returns 'Fragment' for tag 7", () => {
    expect(extractDisplayName(f({ tag: 7 }))).toBe('Fragment');
  });

  it('prefers displayName over function name', () => {
    function Counter() {
      return null;
    }
    (Counter as unknown as { displayName: string }).displayName = 'CounterPretty';
    expect(extractDisplayName(f({ tag: 0, type: Counter }))).toBe('CounterPretty');
  });

  it('uses function.name when displayName is absent', () => {
    function MyComp() {
      return null;
    }
    expect(extractDisplayName(f({ tag: 0, type: MyComp }))).toBe('MyComp');
  });

  it('uses class.name', () => {
    class App {}
    expect(extractDisplayName(f({ tag: 1, type: App }))).toBe('App');
  });

  it('unwraps memo wrapper: Memo(Inner)', () => {
    function Inner() {
      return null;
    }
    const memoType = { type: Inner };
    expect(extractDisplayName(f({ tag: 14, type: memoType }))).toBe('Memo(Inner)');
  });

  it("unwraps memo wrapper with displayName: Memo('DisplayName')", () => {
    const inner = { displayName: 'Pretty' };
    const memoType = { type: inner };
    expect(extractDisplayName(f({ tag: 14, type: memoType }))).toBe('Memo(Pretty)');
  });

  it('unwraps forwardRef wrapper: ForwardRef(Render)', () => {
    function MyRender() {
      return null;
    }
    const fwdType = { render: MyRender };
    expect(extractDisplayName(f({ tag: 11, type: fwdType }))).toBe('ForwardRef(MyRender)');
  });

  it('unwraps memo-of-forwardRef: Memo(ForwardRef(Inner))', () => {
    function Inner() {
      return null;
    }
    const memoOfFwd = { type: { render: Inner } };
    expect(extractDisplayName(f({ tag: 14, type: memoOfFwd }))).toBe('Memo(ForwardRef(Inner))');
  });

  it("returns 'Anonymous' for an anonymous function (function.name is '')", () => {
    const anon = (() => function () {})();
    expect(extractDisplayName(f({ tag: 0, type: anon }))).toBe('Anonymous');
  });

  it("returns 'Anonymous' for memo wrapping an anonymous", () => {
    const memoType = { type: {} };
    expect(extractDisplayName(f({ tag: 14, type: memoType }))).toBe('Memo(Anonymous)');
  });

  it("returns 'Anonymous' when type is null and tag is not a host", () => {
    expect(extractDisplayName(f({ tag: 0, type: null }))).toBe('Anonymous');
  });
});
