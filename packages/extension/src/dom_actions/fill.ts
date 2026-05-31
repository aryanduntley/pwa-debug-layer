// Fill primitive — set the value of a form control the way React expects.
//
// React installs its own value setter on input/textarea elements to track
// changes; assigning `el.value = x` directly updates the DOM but leaves React's
// internal tracker out of sync, so the subsequent change event is treated as a
// no-op and controlled components snap back. The fix is to call the *prototype*
// native setter (which React's descriptor shadows), then dispatch input+change.

import { makeEvent, dispatchAll } from './events.js';
import { type ActionResult, actionOk, actionFail } from './types.js';

type Fillable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const PROTOS: ReadonlyArray<{ ctor: typeof HTMLElement; tag: string }> = [
  { ctor: HTMLInputElement, tag: 'input' },
  { ctor: HTMLTextAreaElement, tag: 'textarea' },
  { ctor: HTMLSelectElement, tag: 'select' },
];

/** Resolve the prototype-level native `value` setter for a control, if any. */
const nativeValueSetter = (el: Element): ((v: string) => void) | undefined => {
  for (const { ctor } of PROTOS) {
    if (typeof ctor === 'function' && el instanceof ctor) {
      const desc = Object.getOwnPropertyDescriptor(ctor.prototype, 'value');
      if (desc?.set) return desc.set.bind(el);
    }
  }
  return undefined;
};

const isFillable = (el: Element): el is Fillable =>
  PROTOS.some(({ ctor }) => typeof ctor === 'function' && el instanceof ctor);

/**
 * Set a control's value via the prototype native setter (bypassing React's
 * value tracker), falling back to direct assignment. Returns whether the native
 * setter was used. Shared by fillElement and keyboard.typeSequence.
 */
export const setNativeValue = (el: Element, value: string): boolean => {
  const setValue = nativeValueSetter(el);
  if (setValue) {
    setValue(value);
    return true;
  }
  (el as { value?: string }).value = value;
  return false;
};

/**
 * Set a form control's value via the native prototype setter (bypassing React's
 * value tracker) and dispatch input + change so controlled onChange fires.
 */
export const fillElement = (el: Element, value: string): ActionResult => {
  if (!isFillable(el)) {
    return actionFail('fill', 'target is not an input, textarea, or select');
  }
  setNativeValue(el, value);

  const { defaultPrevented } = dispatchAll(el, [
    makeEvent('input'),
    makeEvent('change', { cancelable: false }),
  ]);
  return actionOk('fill', { defaultPrevented, detail: { value } });
};
