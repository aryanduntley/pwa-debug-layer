// Hover + focus/blur primitives.
//
// Hover-driven UI (tooltips, dropdown menus, popovers) listens on
// pointerover/mouseover and sometimes pointermove, so the hover sequence
// replays those. focus/blur themselves do NOT bubble; their bubbling
// counterparts focusin/focusout are what delegated handlers listen on, so we
// dispatch those after calling the native focus()/blur().

import { makeMouseEvent, makePointerEvent, dispatchAll } from './events.js';
import { type ActionResult, actionOk, actionFail } from './types.js';

const isElement = (node: unknown): node is HTMLElement =>
  node !== null &&
  typeof node === 'object' &&
  (node as { nodeType?: unknown }).nodeType === 1;

/** Dispatch a pointer/mouse hover sequence so hover-triggered UI opens. */
export const hoverElement = (el: Element): ActionResult => {
  if (!isElement(el)) return actionFail('hover', 'target is not an element');
  const { defaultPrevented } = dispatchAll(el, [
    makePointerEvent('pointerover'),
    makeMouseEvent('mouseover'),
    makePointerEvent('pointerenter', { bubbles: false }),
    makeMouseEvent('mouseenter', { bubbles: false }),
    makePointerEvent('pointermove'),
    makeMouseEvent('mousemove'),
  ]);
  return actionOk('hover', { defaultPrevented });
};

/**
 * Focus a host Element. The native focus() dispatches focus + bubbling focusin
 * itself (we must NOT also dispatch focusin, or delegated handlers fire twice).
 */
export const focusElement = (el: Element): ActionResult => {
  if (!isElement(el)) return actionFail('focus', 'target is not an element');
  el.focus?.();
  return actionOk('focus');
};

/** Blur a host Element. Native blur() dispatches blur + bubbling focusout. */
export const blurElement = (el: Element): ActionResult => {
  if (!isElement(el)) return actionFail('blur', 'target is not an element');
  el.blur?.();
  return actionOk('blur');
};
