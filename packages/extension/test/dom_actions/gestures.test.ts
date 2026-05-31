import { describe, it, expect, vi } from 'vitest';
import { interpolatePoints } from '../../src/dom_actions/geometry.js';
import { scrollElement, dragElement } from '../../src/dom_actions/gestures_pointer.js';
import {
  swipeElement,
  tapElement,
  doubleTapElement,
  longPressElement,
  pinchElement,
} from '../../src/dom_actions/gestures_touch.js';

const mount = (html: string): void => {
  document.body.innerHTML = html;
};

describe('interpolatePoints', () => {
  it('returns `steps` points ending exactly at the destination', () => {
    const pts = interpolatePoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    expect(pts).toHaveLength(5);
    expect(pts[pts.length - 1]).toEqual({ x: 10, y: 0 });
  });
  it('steps<=0 yields just the endpoint', () => {
    expect(interpolatePoints({ x: 0, y: 0 }, { x: 3, y: 3 }, 0)).toEqual([{ x: 3, y: 3 }]);
  });
});

describe('scrollElement', () => {
  it('fires a wheel event and reports acted', () => {
    mount('<div id="d"></div>');
    const el = document.getElementById('d')!;
    const wheel = vi.fn();
    el.addEventListener('wheel', wheel);
    const res = scrollElement(el, { deltaY: 100 });
    expect(res.acted).toBe(true);
    expect(wheel).toHaveBeenCalledTimes(1);
  });
  it('intoView path returns acted with detail', () => {
    mount('<div id="d"></div>');
    const res = scrollElement(document.getElementById('d')!, { intoView: true });
    expect(res.acted).toBe(true);
    expect(res.detail).toMatchObject({ intoView: true });
  });
});

describe('dragElement', () => {
  it('fires pointerdown, N pointermove, pointerup', () => {
    mount('<div id="s"></div><div id="t"></div>');
    const s = document.getElementById('s')!;
    const t = document.getElementById('t')!;
    const down = vi.fn();
    const move = vi.fn();
    const up = vi.fn();
    s.addEventListener('pointerdown', down);
    s.addEventListener('pointermove', move);
    t.addEventListener('pointerup', up);
    const res = dragElement(s, { targetSelector: '#t', steps: 4 });
    expect(res.acted).toBe(true);
    expect(down).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(4);
    expect(up).toHaveBeenCalledTimes(1);
  });
  it('html5 fires the native drag sequence (dragstart + drop)', () => {
    mount('<div id="s"></div><div id="t"></div>');
    const s = document.getElementById('s')!;
    const t = document.getElementById('t')!;
    const dragstart = vi.fn();
    const drop = vi.fn();
    s.addEventListener('dragstart', dragstart);
    t.addEventListener('drop', drop);
    dragElement(s, { targetSelector: '#t', html5: true });
    expect(dragstart).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledTimes(1);
  });
  it('errors without a target', () => {
    mount('<div id="s"></div>');
    expect(dragElement(document.getElementById('s')!, {}).acted).toBe(false);
  });
});

describe('touch gestures', () => {
  it('swipe fires touchstart, N touchmove, touchend', () => {
    mount('<div id="d"></div>');
    const el = document.getElementById('d')!;
    const start = vi.fn();
    const move = vi.fn();
    const end = vi.fn();
    el.addEventListener('touchstart', start);
    el.addEventListener('touchmove', move);
    el.addEventListener('touchend', end);
    const res = swipeElement(el, { direction: 'left', distance: 50, steps: 3 });
    expect(res.acted).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(3);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('tap fires one touch pair, doubleTap two', () => {
    mount('<div id="d"></div>');
    const el = document.getElementById('d')!;
    const start = vi.fn();
    el.addEventListener('touchstart', start);
    expect(tapElement(el).acted).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    doubleTapElement(el);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('pinch fires a two-touch start/move/end sequence', () => {
    mount('<div id="d"></div>');
    const el = document.getElementById('d')!;
    const start = vi.fn();
    const end = vi.fn();
    el.addEventListener('touchstart', start);
    el.addEventListener('touchend', end);
    const res = pinchElement(el, { scale: 2, steps: 3 });
    expect(res.acted).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('longPress (async): touchstart immediately, touchend after the hold', async () => {
    mount('<div id="d"></div>');
    const el = document.getElementById('d')!;
    const start = vi.fn();
    const end = vi.fn();
    el.addEventListener('touchstart', start);
    el.addEventListener('touchend', end);
    const pending = longPressElement(el, { duration: 20 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(0);
    const res = await pending;
    expect(res.acted).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
