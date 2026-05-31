// Click / double-click primitives.
//
// A real user click is a sequence, not a single 'click' event. Frameworks and
// many UI libraries listen on pointer/mouse phases (pointerdown to open menus,
// mousedown to start selections), so we replay the full chain. React's onClick
// is delegated at the root and fires from the bubbling 'click' — which the
// composed+bubbling events from events.ts satisfy.

import { makeMouseEvent, makePointerEvent, dispatchAll } from './events.js';
import { type ActionResult, actionOk, actionFail } from './types.js';

const isElement = (node: unknown): node is HTMLElement =>
  node !== null &&
  typeof node === 'object' &&
  (node as { nodeType?: unknown }).nodeType === 1;

/** The ordered phases of a single pointer+mouse click on `el`. */
const clickSequence = (): readonly Event[] => [
  makePointerEvent('pointerover'),
  makePointerEvent('pointerenter', { bubbles: false }),
  makePointerEvent('pointerdown'),
  makeMouseEvent('mousedown'),
  makePointerEvent('pointerup'),
  makeMouseEvent('mouseup'),
  makeMouseEvent('click'),
];

/**
 * Dispatch a realistic click chain on a host Element (focusing it first, as a
 * real pointer interaction would), so delegated onClick handlers fire.
 */
export const clickElement = (el: Element): ActionResult => {
  if (!isElement(el)) return actionFail('click', 'target is not an element');
  el.focus?.();
  const { defaultPrevented } = dispatchAll(el, clickSequence());
  return actionOk('click', { defaultPrevented });
};

/** Dispatch two click chains followed by a dblclick on a host Element. */
export const dblclickElement = (el: Element): ActionResult => {
  if (!isElement(el)) return actionFail('dblclick', 'target is not an element');
  el.focus?.();
  dispatchAll(el, clickSequence());
  dispatchAll(el, clickSequence());
  const { defaultPrevented } = dispatchAll(el, [makeMouseEvent('dblclick')]);
  return actionOk('dblclick', { defaultPrevented });
};
