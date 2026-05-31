// Keyboard primitives — single key presses and typed strings.
//
// pressKey replays the keydown/keypress/keyup sequence (plus beforeinput/input
// for printable keys on editable targets) using a named-key table so callers
// can pass 'Enter'/'Tab'/'ArrowDown' as well as literal characters.
// typeSequence types a string char-by-char, mutating the value via the shared
// native setter (see fill.ts) so React controlled inputs track each keystroke.

import { makeKeyboardEvent, makeEvent, dispatchAll } from './events.js';
import { setNativeValue } from './fill.js';
import { type ActionResult, actionOk, actionFail } from './types.js';

type KeySpec = { readonly code: string; readonly keyCode: number };

/** Named (non-printable) keys → DOM code + legacy keyCode. */
const NAMED_KEYS: Readonly<Record<string, KeySpec>> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ' ': { code: 'Space', keyCode: 32 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
};

const isElement = (node: unknown): node is HTMLElement =>
  node !== null &&
  typeof node === 'object' &&
  (node as { nodeType?: unknown }).nodeType === 1;

const isPrintable = (key: string): boolean => key.length === 1 && key !== '\n';

/** Resolve a key string to its code/keyCode (printable chars derive their own). */
const specFor = (key: string): KeySpec => {
  const named = NAMED_KEYS[key];
  if (named) return named;
  const upper = key.toUpperCase();
  return { code: /^[a-z]$/i.test(key) ? `Key${upper}` : key, keyCode: upper.charCodeAt(0) || 0 };
};

/**
 * Dispatch a single key's event sequence on a host Element. Printable keys on
 * editable targets also emit beforeinput/input (callers mutate value when they
 * need the character committed; typeSequence does this).
 */
export const pressKey = (el: Element, key: string): ActionResult => {
  if (!isElement(el)) return actionFail('keyPress', 'target is not an element');
  const { code, keyCode } = specFor(key);
  const init = { key, code, keyCode, which: keyCode };
  const events: Event[] = [makeKeyboardEvent('keydown', init)];
  if (isPrintable(key)) {
    events.push(makeKeyboardEvent('keypress', init));
    events.push(makeEvent('beforeinput'));
  }
  events.push(makeKeyboardEvent('keyup', init));
  const { defaultPrevented } = dispatchAll(el, events);
  return actionOk('keyPress', { defaultPrevented, detail: { key, code } });
};

/**
 * Type a string into an editable target char-by-char: per character replay the
 * key sequence and append the character to the value via the native setter +
 * an input event, ending with a single change event.
 */
export const typeSequence = (el: Element, text: string): ActionResult => {
  if (!isElement(el)) return actionFail('typeSequence', 'target is not an element');
  let value = (el as { value?: string }).value ?? '';
  for (const char of text) {
    const spec = specFor(char);
    const init = { key: char, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode };
    dispatchAll(el, [makeKeyboardEvent('keydown', init), makeKeyboardEvent('keypress', init)]);
    value += char;
    setNativeValue(el, value);
    dispatchAll(el, [makeEvent('input'), makeKeyboardEvent('keyup', init)]);
  }
  dispatchAll(el, [makeEvent('change', { cancelable: false })]);
  return actionOk('typeSequence', { detail: { text, value } });
};
