import { describe, it, expect } from 'vitest';
import { computeFrameMeta } from '../../src/frame_meta/frame_meta.js';

type FakeWin = {
  parent: FakeWin;
  top: FakeWin;
  frames: FakeWin[];
  location: { href: string };
};

const makeTop = (href: string): FakeWin => {
  const top = {
    frames: [] as FakeWin[],
    location: { href },
  } as FakeWin;
  top.parent = top;
  top.top = top;
  return top;
};

const attachSameOriginChild = (parent: FakeWin, href: string): FakeWin => {
  const child = {
    frames: [] as FakeWin[],
    location: { href },
  } as FakeWin;
  child.parent = parent;
  child.top = parent.top;
  parent.frames.push(child);
  return child;
};

const attachCrossOriginChild = (parent: FakeWin, href: string): FakeWin => {
  const child = {
    frames: [] as FakeWin[],
    location: { href },
  } as FakeWin;
  // parent assignment goes through Object.defineProperty so we control behavior
  Object.defineProperty(child, 'parent', {
    get(): FakeWin {
      return new Proxy(parent, {
        get(target, prop): unknown {
          if (prop === 'location') {
            throw new DOMException(
              'Blocked a frame with origin "..." from accessing a cross-origin frame.',
              'SecurityError',
            );
          }
          if (prop === 'frames') return target.frames;
          return Reflect.get(target, prop);
        },
      });
    },
  });
  child.top = parent.top;
  parent.frames.push(child);
  return child;
};

const asWindow = (w: FakeWin): Window => w as unknown as Window;

describe('computeFrameMeta', () => {
  it('top frame: isCrossOrigin=false, frameKey="top"', () => {
    const top = makeTop('https://example.com/');
    const meta = computeFrameMeta(asWindow(top));
    expect(meta.frameUrl).toBe('https://example.com/');
    expect(meta.frameKey).toBe('top');
    expect(meta.isCrossOrigin).toBe(false);
  });

  it('same-origin nested frame: isCrossOrigin=false, frameKey="top/0"', () => {
    const top = makeTop('https://example.com/');
    const child = attachSameOriginChild(top, 'https://example.com/sub');
    const meta = computeFrameMeta(asWindow(child));
    expect(meta.frameUrl).toBe('https://example.com/sub');
    expect(meta.frameKey).toBe('top/0');
    expect(meta.isCrossOrigin).toBe(false);
  });

  it('cross-origin nested frame: isCrossOrigin=true (parent.location.href throws)', () => {
    const top = makeTop('https://example.com/');
    const child = attachCrossOriginChild(top, 'https://other.example/sub');
    const meta = computeFrameMeta(asWindow(child));
    expect(meta.frameUrl).toBe('https://other.example/sub');
    expect(meta.isCrossOrigin).toBe(true);
  });

  it('default win parameter uses global window', () => {
    const meta = computeFrameMeta();
    expect(typeof meta.frameUrl).toBe('string');
    expect(typeof meta.frameKey).toBe('string');
    expect(typeof meta.isCrossOrigin).toBe('boolean');
  });
});
