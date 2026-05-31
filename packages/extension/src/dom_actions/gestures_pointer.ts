// Pointer-based gestures: drag (pointer + optional HTML5 DnD) and scroll.

import { makePointerEvent, makeWheelEvent, makeDragEvent, dispatchAll } from './events.js';
import { centerOf, interpolatePoints, type Point } from './geometry.js';
import { type ActionResult, actionOk, actionFail } from './types.js';

const isElement = (node: unknown): node is HTMLElement =>
  node !== null &&
  typeof node === 'object' &&
  (node as { nodeType?: unknown }).nodeType === 1;

const newDataTransfer = (): DataTransfer =>
  typeof DataTransfer === 'function' ? new DataTransfer() : ({} as DataTransfer);

/**
 * Drag a source element to a target point or element: pointerdown at the source
 * center, interpolated pointermove steps, pointerup at the destination. With
 * html5:true also fires the native DnD sequence (dragstart/dragenter/dragover/
 * drop/dragend) sharing one DataTransfer, for libraries using the drag API.
 */
export const dragElement = (
  source: Element,
  opts: { toX?: number; toY?: number; targetSelector?: string; steps?: number; html5?: boolean },
): ActionResult => {
  if (!isElement(source)) return actionFail('drag', 'source is not an element');
  const start = centerOf(source);
  let targetEl: Element | null = null;
  let dest: Point;
  if (opts.targetSelector !== undefined) {
    targetEl = document.querySelector(opts.targetSelector);
    if (targetEl === null) {
      return actionFail('drag', `targetSelector matched nothing: ${opts.targetSelector}`);
    }
    dest = centerOf(targetEl);
  } else if (opts.toX !== undefined && opts.toY !== undefined) {
    dest = { x: opts.toX, y: opts.toY };
  } else {
    return actionFail('drag', 'provide targetSelector or both toX and toY');
  }

  const steps = opts.steps ?? 10;
  const path = interpolatePoints(start, dest, steps);
  const at = (p: Point) => ({ clientX: p.x, clientY: p.y });

  dispatchAll(source, [makePointerEvent('pointerdown', at(start))]);
  for (const p of path) dispatchAll(source, [makePointerEvent('pointermove', at(p))]);
  const upTarget = targetEl ?? source;
  const { defaultPrevented } = dispatchAll(upTarget, [makePointerEvent('pointerup', at(dest))]);

  if (opts.html5) {
    const dt = newDataTransfer();
    const dndTarget = targetEl ?? source;
    dispatchAll(source, [makeDragEvent('dragstart', dt, at(start))]);
    dispatchAll(dndTarget, [makeDragEvent('dragenter', dt, at(dest))]);
    dispatchAll(dndTarget, [makeDragEvent('dragover', dt, at(dest))]);
    dispatchAll(dndTarget, [makeDragEvent('drop', dt, at(dest))]);
    dispatchAll(source, [makeDragEvent('dragend', dt, at(dest))]);
  }

  return actionOk('drag', {
    defaultPrevented,
    detail: { from: start, to: dest, steps, html5: opts.html5 === true },
  });
};

/**
 * Scroll a target element: when intoView, scrollIntoView (centered); otherwise
 * dispatch a wheel event (so wheel-listening handlers fire) AND scrollBy the
 * delta. Returns the resulting scroll position.
 */
export const scrollElement = (
  el: Element,
  opts: { deltaX?: number; deltaY?: number; intoView?: boolean },
): ActionResult => {
  if (!isElement(el)) return actionFail('scroll', 'target is not an element');
  if (opts.intoView) {
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    return actionOk('scroll', { detail: { intoView: true } });
  }
  const deltaX = opts.deltaX ?? 0;
  const deltaY = opts.deltaY ?? 0;
  const { defaultPrevented } = dispatchAll(el, [makeWheelEvent('wheel', { deltaX, deltaY })]);
  if (typeof el.scrollBy === 'function') el.scrollBy(deltaX, deltaY);
  return actionOk('scroll', {
    defaultPrevented,
    detail: { deltaX, deltaY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop },
  });
};
