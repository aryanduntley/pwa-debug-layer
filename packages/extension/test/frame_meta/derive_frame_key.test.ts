import { describe, it, expect } from 'vitest';
import { deriveFrameKey } from '../../src/frame_meta/derive_frame_key.js';

type FakeWin = {
  parent: FakeWin;
  top: FakeWin;
  frames: FakeWin[];
};

const makeTop = (): FakeWin => {
  const top = { frames: [] as FakeWin[] } as FakeWin;
  top.parent = top;
  top.top = top;
  return top;
};

const attachChild = (parent: FakeWin): FakeWin => {
  const child = { frames: [] as FakeWin[] } as FakeWin;
  child.parent = parent;
  child.top = parent.top;
  parent.frames.push(child);
  return child;
};

const asWindow = (w: FakeWin): Window => w as unknown as Window;

describe('deriveFrameKey', () => {
  it("returns 'top' when win === win.top", () => {
    const top = makeTop();
    expect(deriveFrameKey(asWindow(top))).toBe('top');
  });

  it("returns 'top/0' for the only child of top", () => {
    const top = makeTop();
    const child = attachChild(top);
    expect(deriveFrameKey(asWindow(child))).toBe('top/0');
  });

  it("returns 'top/2' for the third child of top", () => {
    const top = makeTop();
    attachChild(top);
    attachChild(top);
    const third = attachChild(top);
    expect(deriveFrameKey(asWindow(third))).toBe('top/2');
  });

  it("returns 'top/2/0' for nested same-origin chain", () => {
    const top = makeTop();
    attachChild(top);
    attachChild(top);
    const middle = attachChild(top);
    const inner = attachChild(middle);
    expect(deriveFrameKey(asWindow(inner))).toBe('top/2/0');
  });

  it('returns three-level path for deeply nested chain', () => {
    const top = makeTop();
    const a = attachChild(top);
    const b = attachChild(a);
    const c = attachChild(b);
    expect(deriveFrameKey(asWindow(c))).toBe('top/0/0/0');
  });

  it('falls back when parent property access throws (cross-origin)', () => {
    const top = makeTop();
    const child = { frames: [] as FakeWin[] } as FakeWin;
    child.top = top;
    Object.defineProperty(child, 'parent', {
      get() {
        throw new Error('SecurityError');
      },
    });

    const result = deriveFrameKey(asWindow(child), () => 'cross_origin/fixed');
    expect(result).toBe('cross_origin/fixed');
  });

  it('falls back when win is not present in parent.frames (detached)', () => {
    const top = makeTop();
    const orphan = { frames: [] as FakeWin[] } as FakeWin;
    orphan.parent = top;
    orphan.top = top;

    const result = deriveFrameKey(asWindow(orphan), () => 'cross_origin/orphan');
    expect(result).toBe('cross_origin/orphan');
  });

  it('memoizes the fallback within a single call (called at most once)', () => {
    const top = makeTop();
    const child = { frames: [] as FakeWin[] } as FakeWin;
    child.top = top;
    Object.defineProperty(child, 'parent', {
      get() {
        throw new Error('SecurityError');
      },
    });

    let calls = 0;
    const fallback = (): string => {
      calls += 1;
      return `gen-${calls}`;
    };
    const out = deriveFrameKey(asWindow(child), fallback);
    expect(out).toBe('gen-1');
    expect(calls).toBe(1);
  });

  it('default fallback returns a cross_origin/<id> string when parent throws', () => {
    const top = makeTop();
    const child = { frames: [] as FakeWin[] } as FakeWin;
    child.top = top;
    Object.defineProperty(child, 'parent', {
      get() {
        throw new Error('SecurityError');
      },
    });

    const result = deriveFrameKey(asWindow(child));
    expect(result.startsWith('cross_origin/')).toBe(true);
    expect(result.length).toBeGreaterThan('cross_origin/'.length);
  });
});
