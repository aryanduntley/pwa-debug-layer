// Touch gestures: swipe, tap, double-tap, long-press (async), pinch.
// Each replays a Touch/TouchList sequence (touchstart -> touchmove* -> touchend)
// so touch-driven handlers fire. longPress is async because it must hold
// between touchstart and touchend long enough for the page's long-press timer.

import { makeTouch, makeTouchEvent, makeMouseEvent, dispatchAll } from './events.js';
import { centerOf, interpolatePoints, type Point } from './geometry.js';
import { type ActionResult, actionOk, actionFail } from './types.js';

const isElement = (node: unknown): node is HTMLElement =>
  node !== null &&
  typeof node === 'object' &&
  (node as { nodeType?: unknown }).nodeType === 1;

const DIRECTIONS: Readonly<Record<string, Point>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** Swipe a touch across an element in a direction by a distance over N steps. */
export const swipeElement = (
  el: Element,
  opts: { direction: 'up' | 'down' | 'left' | 'right'; distance?: number; steps?: number },
): ActionResult => {
  if (!isElement(el)) return actionFail('swipe', 'target is not an element');
  const dir = DIRECTIONS[opts.direction];
  if (dir === undefined) return actionFail('swipe', `invalid direction: ${opts.direction}`);
  const distance = opts.distance ?? 100;
  const steps = opts.steps ?? 10;
  const c = centerOf(el);
  const end = { x: c.x + dir.x * distance, y: c.y + dir.y * distance };

  dispatchAll(el, [makeTouchEvent('touchstart', [makeTouch(el, c.x, c.y)])]);
  for (const p of interpolatePoints(c, end, steps)) {
    dispatchAll(el, [makeTouchEvent('touchmove', [makeTouch(el, p.x, p.y)])]);
  }
  const { defaultPrevented } = dispatchAll(el, [
    makeTouchEvent('touchend', [], [makeTouch(el, end.x, end.y)]),
  ]);
  return actionOk('swipe', { defaultPrevented, detail: { direction: opts.direction, distance, steps } });
};

/** One touchstart/touchend pair at a point; returns defaultPrevented. */
const tapOnce = (el: Element, c: Point): boolean => {
  dispatchAll(el, [makeTouchEvent('touchstart', [makeTouch(el, c.x, c.y)])]);
  return dispatchAll(el, [makeTouchEvent('touchend', [], [makeTouch(el, c.x, c.y)])]).defaultPrevented;
};

/** Tap an element (single touchstart/touchend at its center). */
export const tapElement = (el: Element): ActionResult => {
  if (!isElement(el)) return actionFail('tap', 'target is not an element');
  const defaultPrevented = tapOnce(el, centerOf(el));
  return actionOk('tap', { defaultPrevented });
};

/** Double-tap an element (two touchstart/touchend pairs). */
export const doubleTapElement = (el: Element): ActionResult => {
  if (!isElement(el)) return actionFail('doubleTap', 'target is not an element');
  const c = centerOf(el);
  tapOnce(el, c);
  const defaultPrevented = tapOnce(el, c);
  return actionOk('doubleTap', { defaultPrevented });
};

/**
 * Long-press (async): touchstart, hold for `duration` ms so the page's
 * long-press timer fires, then touchend + contextmenu.
 */
export const longPressElement = async (
  el: Element,
  opts: { duration?: number } = {},
): Promise<ActionResult> => {
  if (!isElement(el)) return actionFail('longPress', 'target is not an element');
  const c = centerOf(el);
  const duration = opts.duration ?? 500;
  dispatchAll(el, [makeTouchEvent('touchstart', [makeTouch(el, c.x, c.y)])]);
  await new Promise<void>((resolve) => setTimeout(resolve, duration));
  dispatchAll(el, [makeTouchEvent('touchend', [], [makeTouch(el, c.x, c.y)])]);
  const { defaultPrevented } = dispatchAll(el, [
    makeMouseEvent('contextmenu', { clientX: c.x, clientY: c.y }),
  ]);
  return actionOk('longPress', { defaultPrevented, detail: { duration } });
};

/**
 * Pinch-zoom on an element with two touches symmetric about its center: scale>1
 * diverges (zoom in), scale<1 converges (zoom out), interpolated over N steps.
 */
export const pinchElement = (
  el: Element,
  opts: { scale: number; steps?: number },
): ActionResult => {
  if (!isElement(el)) return actionFail('pinch', 'target is not an element');
  const steps = opts.steps ?? 10;
  const c = centerOf(el);
  const sep = 50;
  const a0 = { x: c.x - sep, y: c.y };
  const b0 = { x: c.x + sep, y: c.y };
  const a1 = { x: c.x - sep * opts.scale, y: c.y };
  const b1 = { x: c.x + sep * opts.scale, y: c.y };
  const pa = interpolatePoints(a0, a1, steps);
  const pb = interpolatePoints(b0, b1, steps);

  dispatchAll(el, [
    makeTouchEvent('touchstart', [makeTouch(el, a0.x, a0.y, 0), makeTouch(el, b0.x, b0.y, 1)]),
  ]);
  for (let i = 0; i < pa.length; i++) {
    const a = pa[i]!;
    const b = pb[i]!;
    dispatchAll(el, [
      makeTouchEvent('touchmove', [makeTouch(el, a.x, a.y, 0), makeTouch(el, b.x, b.y, 1)]),
    ]);
  }
  const { defaultPrevented } = dispatchAll(el, [
    makeTouchEvent('touchend', [], [makeTouch(el, a1.x, a1.y, 0), makeTouch(el, b1.x, b1.y, 1)]),
  ]);
  return actionOk('pinch', { defaultPrevented, detail: { scale: opts.scale, steps } });
};
