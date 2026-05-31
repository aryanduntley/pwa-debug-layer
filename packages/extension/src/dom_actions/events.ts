// Shared native-event builders + the single dispatch seam for dom_actions.
//
// Builders are pure: they construct DOM events with delegated-handler-friendly
// defaults so the events behave like genuine user input. `bubbles` lets events
// reach React's root-level delegated listeners; `composed` lets them cross
// shadow boundaries (retargeted to the host) so handlers inside web components
// / shadow DOM still fire. `dispatchAll` is the only side-effecting function —
// every primitive composes pure builders, then dispatches once at the edge.

const BASE: EventInit = { bubbles: true, cancelable: true, composed: true };

/** MouseEvent with delegated-handler-friendly defaults merged with `init`. */
export const makeMouseEvent = (
  type: string,
  init: MouseEventInit = {},
): MouseEvent =>
  new MouseEvent(type, { ...BASE, view: window, button: 0, ...init });

/**
 * PointerEvent with bubbles+cancelable+composed defaults. Falls back to a
 * MouseEvent of the same type when the engine lacks a PointerEvent constructor
 * (older jsdom), keeping dispatch chains robust under test.
 */
export const makePointerEvent = (
  type: string,
  init: PointerEventInit = {},
): PointerEvent | MouseEvent => {
  const merged = {
    ...BASE,
    view: window,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    ...init,
  };
  if (typeof PointerEvent === 'function') return new PointerEvent(type, merged);
  return new MouseEvent(type, merged);
};

/** KeyboardEvent with delegated-handler-friendly defaults merged with `init`. */
export const makeKeyboardEvent = (
  type: string,
  init: KeyboardEventInit = {},
): KeyboardEvent =>
  new KeyboardEvent(type, { ...BASE, view: window, ...init });

/**
 * Plain Event with bubbles+composed defaults. Used for input/change/submit/
 * focusin/focusout where a typed constructor is unnecessary or not
 * cross-engine constructable. `cancelable` defaults true but callers may
 * override (e.g. `change` is conventionally non-cancelable).
 */
export const makeEvent = (type: string, init: EventInit = {}): Event =>
  new Event(type, { ...BASE, ...init });

/** WheelEvent (deltaX/deltaY) for the scroll wheel-event variant; Event fallback. */
export const makeWheelEvent = (
  type: string,
  init: WheelEventInit = {},
): WheelEvent | Event => {
  const merged = { ...BASE, view: window, ...init };
  if (typeof WheelEvent === 'function') return new WheelEvent(type, merged);
  return new Event(type, BASE);
};

/** Touch object for touch-event sequences; a plain touch-like object as fallback. */
export const makeTouch = (
  target: EventTarget,
  x: number,
  y: number,
  identifier = 0,
): Touch => {
  const init = {
    identifier,
    target,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    screenX: x,
    screenY: y,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  };
  if (typeof Touch === 'function') return new Touch(init);
  return init as unknown as Touch;
};

/**
 * TouchEvent with touches/targetTouches/changedTouches. For touchstart/touchmove
 * pass the active touches; for touchend pass the REMAINING touches (often [])
 * plus the lifted touches as changedTouches. Event fallback carries the lists.
 */
export const makeTouchEvent = (
  type: string,
  touches: Touch[],
  changedTouches: Touch[] = touches,
): TouchEvent | Event => {
  if (typeof TouchEvent === 'function') {
    return new TouchEvent(type, {
      ...BASE,
      view: window,
      touches,
      targetTouches: touches,
      changedTouches,
    });
  }
  const ev = new Event(type, BASE) as Event & {
    touches?: Touch[];
    targetTouches?: Touch[];
    changedTouches?: Touch[];
  };
  ev.touches = touches;
  ev.targetTouches = touches;
  ev.changedTouches = changedTouches;
  return ev;
};

/**
 * DragEvent carrying a DataTransfer. One DataTransfer instance is shared across
 * a drag sequence so setData/getData round-trips. MouseEvent-with-dataTransfer
 * fallback when DragEvent is unconstructable.
 */
export const makeDragEvent = (
  type: string,
  dataTransfer: DataTransfer,
  init: MouseEventInit = {},
): DragEvent | MouseEvent => {
  const merged = { ...BASE, view: window, ...init };
  if (typeof DragEvent === 'function') {
    return new DragEvent(type, { ...merged, dataTransfer });
  }
  const ev = new MouseEvent(type, merged) as MouseEvent & {
    dataTransfer?: DataTransfer;
  };
  ev.dataTransfer = dataTransfer;
  return ev;
};

/**
 * Dispatch a pre-built sequence of events on `target` in order. Reports whether
 * any cancelable event had preventDefault() called — `dispatchEvent` returns
 * false exactly when the event was cancelable and its default was prevented.
 * The single side-effecting seam in dom_actions.
 */
export const dispatchAll = (
  target: EventTarget,
  events: readonly Event[],
): { defaultPrevented: boolean } => {
  let defaultPrevented = false;
  for (const event of events) {
    const notPrevented = target.dispatchEvent(event);
    if (!notPrevented) defaultPrevented = true;
  }
  return { defaultPrevented };
};
