// Submit primitive — fire a real form submission.
//
// requestSubmit() is preferred over form.submit(): it dispatches a cancelable
// 'submit' event (so React's onSubmit and native validation run), whereas
// form.submit() bypasses the event entirely. When requestSubmit is missing
// (older engines / jsdom), fall back to dispatching a submit Event directly.

import { makeEvent, dispatchAll } from './events.js';
import { type ActionResult, actionOk, actionFail } from './types.js';

/** Resolve the form a target belongs to (itself, its .form, or nearest ancestor). */
const resolveForm = (target: Element): HTMLFormElement | undefined => {
  if (typeof HTMLFormElement === 'function' && target instanceof HTMLFormElement) {
    return target;
  }
  const owned = (target as { form?: unknown }).form;
  if (typeof HTMLFormElement === 'function' && owned instanceof HTMLFormElement) {
    return owned;
  }
  return target.closest?.('form') ?? undefined;
};

/**
 * Submit the form owning `target` via requestSubmit() (cancelable submit event),
 * falling back to a dispatched submit Event. Errors when no form is found.
 */
export const submitForm = (target: Element): ActionResult => {
  const form = resolveForm(target);
  if (!form) return actionFail('submit', 'no owning <form> found for target');

  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit();
    return actionOk('submit', { detail: { via: 'requestSubmit' } });
  }
  const { defaultPrevented } = dispatchAll(form, [makeEvent('submit')]);
  return actionOk('submit', { defaultPrevented, detail: { via: 'dispatch' } });
};
