// Page-world capstone: resolve a locator, then apply a dom_actions primitive to
// the resolved element. The single composition point of interaction_locator +
// dom_actions, called by the page-world tool handlers. Async because some
// gestures (long-press) must hold across a real delay.

import { resolveLocator } from './resolve.js';
import type { Locator, LocatorFramework } from './types.js';
import { clickElement, dblclickElement } from '../dom_actions/click.js';
import { fillElement } from '../dom_actions/fill.js';
import { submitForm } from '../dom_actions/submit.js';
import { hoverElement, focusElement, blurElement } from '../dom_actions/hover_focus.js';
import { setChecked, selectOption } from '../dom_actions/toggle_select.js';
import { pressKey, typeSequence } from '../dom_actions/keyboard.js';
import { dragElement, scrollElement } from '../dom_actions/gestures_pointer.js';
import {
  swipeElement,
  tapElement,
  doubleTapElement,
  longPressElement,
  pinchElement,
} from '../dom_actions/gestures_touch.js';
import { type ActionResult, actionFail } from '../dom_actions/types.js';

export type ActionRunResult =
  | {
      readonly located: { readonly describedBy: string; readonly matchCount: number };
      readonly action: ActionResult;
    }
  | { readonly error: { readonly message: string } };

const FRAMEWORKS: readonly LocatorFramework[] = ['react', 'vue', 'svelte', 'solid', 'dom'];
const LOCATOR_KEYS = new Set([
  'framework', 'selector', 'role', 'name', 'text', 'exact', 'stable_id', 'nth', 'require_unique',
]);

const asFramework = (v: unknown): LocatorFramework | undefined =>
  typeof v === 'string' && (FRAMEWORKS as readonly string[]).includes(v)
    ? (v as LocatorFramework)
    : undefined;

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Parse a wire payload into a Locator (snake_case->camelCase) + a params record. */
export const readActionInput = (
  raw: unknown,
): { locator: Locator; params: Record<string, unknown> } | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const loc: {
    framework?: LocatorFramework;
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    exact?: boolean;
    stableId?: string;
    nth?: number;
    requireUnique?: boolean;
  } = {};
  const fw = asFramework(r['framework']);
  if (fw !== undefined) loc.framework = fw;
  if (typeof r['selector'] === 'string') loc.selector = r['selector'];
  if (typeof r['role'] === 'string') loc.role = r['role'];
  if (typeof r['name'] === 'string') loc.name = r['name'];
  if (typeof r['text'] === 'string') loc.text = r['text'];
  if (typeof r['exact'] === 'boolean') loc.exact = r['exact'];
  if (typeof r['stable_id'] === 'string') loc.stableId = r['stable_id'];
  if (typeof r['nth'] === 'number' && Number.isInteger(r['nth']) && r['nth'] >= 0) loc.nth = r['nth'];
  if (typeof r['require_unique'] === 'boolean') loc.requireUnique = r['require_unique'];

  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!LOCATOR_KEYS.has(k) && v !== undefined) params[k] = v;
  }
  return { locator: Object.freeze(loc), params };
};

const fail = (message: string): ActionRunResult => Object.freeze({ error: Object.freeze({ message }) });

/** Resolve `locator` and apply the `action` dom_actions primitive to the match. */
export const runAction = async (
  doc: Document,
  action: string,
  locator: Locator,
  params: Record<string, unknown>,
): Promise<ActionRunResult> => {
  const res = resolveLocator(doc, locator);
  if (!res.ok) return fail(res.error);
  const el = res.element;
  const located = Object.freeze({ describedBy: res.describedBy, matchCount: res.matchCount });
  const done = (action_result: ActionResult): ActionRunResult =>
    Object.freeze({ located, action: action_result });

  switch (action) {
    case 'click':
      return done(clickElement(el));
    case 'dblclick':
      return done(dblclickElement(el));
    case 'fill': {
      const value = str(params['value']);
      if (value === undefined) return fail('pdl_fill requires a value');
      return done(fillElement(el, value));
    }
    case 'submit':
      return done(submitForm(el));
    case 'hover':
      return done(hoverElement(el));
    case 'focus':
      return done(focusElement(el));
    case 'blur':
      return done(blurElement(el));
    case 'check':
      return done(setChecked(el, true));
    case 'uncheck':
      return done(setChecked(el, false));
    case 'selectOption': {
      const value = str(params['value']);
      const label = str(params['label']);
      if (value === undefined && label === undefined) {
        return fail('pdl_select_option requires a value or label');
      }
      return done(
        selectOption(el, {
          ...(value !== undefined ? { value } : {}),
          ...(label !== undefined ? { label } : {}),
        }),
      );
    }
    case 'keyPress': {
      const key = str(params['key']);
      if (key === undefined) return fail('pdl_key_press requires a key');
      return done(pressKey(el, key));
    }
    case 'typeSequence': {
      const value = str(params['value']);
      if (value === undefined) return fail('pdl_type_sequence requires a value');
      return done(typeSequence(el, value));
    }
    case 'drag': {
      const toX = num(params['toX']);
      const toY = num(params['toY']);
      const targetSelector = str(params['targetSelector']);
      const steps = num(params['steps']);
      const html5 = params['html5'] === true;
      return done(
        dragElement(el, {
          ...(toX !== undefined ? { toX } : {}),
          ...(toY !== undefined ? { toY } : {}),
          ...(targetSelector !== undefined ? { targetSelector } : {}),
          ...(steps !== undefined ? { steps } : {}),
          html5,
        }),
      );
    }
    case 'scroll': {
      const deltaX = num(params['deltaX']);
      const deltaY = num(params['deltaY']);
      const intoView = params['intoView'] === true;
      return done(
        scrollElement(el, {
          ...(deltaX !== undefined ? { deltaX } : {}),
          ...(deltaY !== undefined ? { deltaY } : {}),
          intoView,
        }),
      );
    }
    case 'swipe': {
      const direction = str(params['direction']);
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        return fail('pdl_swipe requires direction up|down|left|right');
      }
      const distance = num(params['distance']);
      const steps = num(params['steps']);
      return done(
        swipeElement(el, {
          direction,
          ...(distance !== undefined ? { distance } : {}),
          ...(steps !== undefined ? { steps } : {}),
        }),
      );
    }
    case 'tap':
      return done(tapElement(el));
    case 'doubleTap':
      return done(doubleTapElement(el));
    case 'longPress': {
      const duration = num(params['duration']);
      return done(await longPressElement(el, duration !== undefined ? { duration } : {}));
    }
    case 'pinch': {
      const scale = num(params['scale']);
      if (scale === undefined) return fail('pdl_pinch requires a numeric scale');
      const steps = num(params['steps']);
      return done(pinchElement(el, { scale, ...(steps !== undefined ? { steps } : {}) }));
    }
    default:
      return done(actionFail('click', `unknown action: ${action}`));
  }
};
