// dom_actions result contract — shared by every action primitive.
// Pure value types + tiny result constructors; no DOM access here.

/**
 * Discriminator naming each discrete dom_actions primitive. Carried in every
 * ActionResult so handlers know which action ran. Gesture kinds
 * (drag/scroll/swipe/...) extend this union in the touch-gesture milestone.
 */
export type ActionKind =
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'submit'
  | 'hover'
  | 'focus'
  | 'blur'
  | 'check'
  | 'uncheck'
  | 'selectOption'
  | 'keyPress'
  | 'typeSequence'
  | 'drag'
  | 'scroll'
  | 'swipe'
  | 'tap'
  | 'doubleTap'
  | 'longPress'
  | 'pinch';

/**
 * Uniform result returned by every dom_actions primitive.
 * - `acted` is true on success.
 * - `defaultPrevented` reflects whether a dispatched cancelable event was canceled.
 * - `detail` carries action-specific observations (final input value, selected
 *   option, key sequence).
 * - `error` is set only when `acted` is false.
 */
export type ActionResult = {
  readonly acted: boolean;
  readonly action: ActionKind;
  readonly defaultPrevented?: boolean;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly error?: string;
};

/** Construct a successful ActionResult, merging optional extra fields. */
export const actionOk = (
  action: ActionKind,
  extra: Partial<ActionResult> = {},
): ActionResult => ({ acted: true, action, ...extra });

/** Construct a failed ActionResult with an explanation. */
export const actionFail = (action: ActionKind, error: string): ActionResult => ({
  acted: false,
  action,
  error,
});
