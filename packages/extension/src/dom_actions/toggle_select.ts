// Checkbox/radio toggle + <select> option choice.
//
// For checkable inputs we drive the change through the native click path rather
// than setting `.checked` directly: clicking is what React's onChange listens
// for, and it keeps the DOM, React state, and any radio-group siblings
// consistent. setChecked is therefore idempotent — it only clicks when the
// current state differs from the requested one.

import { makeEvent, dispatchAll } from './events.js';
import { clickElement } from './click.js';
import { type ActionResult, actionOk, actionFail } from './types.js';

const isCheckable = (el: Element): el is HTMLInputElement =>
  typeof HTMLInputElement === 'function' &&
  el instanceof HTMLInputElement &&
  (el.type === 'checkbox' || el.type === 'radio');

/**
 * Drive a checkbox/radio to `checked`. No-op when already in that state;
 * otherwise routes through the native click path so onChange fires.
 */
export const setChecked = (el: Element, checked: boolean): ActionResult => {
  if (!isCheckable(el)) {
    return actionFail(
      checked ? 'check' : 'uncheck',
      'target is not a checkbox or radio input',
    );
  }
  const kind = checked ? 'check' : 'uncheck';
  if (el.checked === checked) {
    return actionOk(kind, { detail: { changed: false, checked } });
  }
  const res = clickElement(el);
  return actionOk(kind, {
    defaultPrevented: res.defaultPrevented ?? false,
    detail: { changed: true, checked: el.checked },
  });
};

/**
 * Select an <option> by value or visible label, set the select's value, and
 * dispatch change. Errors when no matching option exists.
 */
export const selectOption = (
  el: Element,
  opts: { value?: string; label?: string },
): ActionResult => {
  if (!(typeof HTMLSelectElement === 'function' && el instanceof HTMLSelectElement)) {
    return actionFail('selectOption', 'target is not a <select>');
  }
  const options = Array.from(el.options);
  const match =
    opts.value !== undefined
      ? options.find((o) => o.value === opts.value)
      : options.find((o) => o.text.trim() === opts.label?.trim());
  if (!match) {
    return actionFail('selectOption', 'no option matched the given value/label');
  }
  el.value = match.value;
  const { defaultPrevented } = dispatchAll(el, [
    makeEvent('input'),
    makeEvent('change', { cancelable: false }),
  ]);
  return actionOk('selectOption', {
    defaultPrevented,
    detail: { value: match.value, label: match.text.trim() },
  });
};
