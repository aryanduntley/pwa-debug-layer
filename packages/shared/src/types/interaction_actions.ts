// Single source of truth for the Path 7 pdl_* interaction action tools.
//
// Both the host (builds a ToolDef + Zod schema per entry) and the extension
// (SW request routing + page-world dispatch) import this table, so tool names,
// their dom_actions action kind, and their parameters stay in sync across
// packages. Adding a tool = one entry here + (for new param shapes) the typed
// param model below; the three generic layers need no per-tool code.

/** Wire type of a non-locator action parameter. */
export type ActionParamType = 'string' | 'number' | 'boolean' | 'enum';

/** One non-locator parameter of an action tool. */
export type ActionParamDef = {
  readonly key: string;
  readonly type: ActionParamType;
  readonly required?: boolean;
  /** Allowed values when type==='enum'. */
  readonly enum?: readonly string[];
  readonly description?: string;
};

/** One pdl_* action tool: name, the dom_actions action kind, params, summary. */
export type ActionToolSpec = {
  readonly tool: string;
  readonly action: string;
  readonly params: readonly ActionParamDef[];
  readonly summary: string;
};

const S = (key: string, required = false, description?: string): ActionParamDef => ({
  key,
  type: 'string',
  ...(required ? { required } : {}),
  ...(description !== undefined ? { description } : {}),
});
const N = (key: string, required = false, description?: string): ActionParamDef => ({
  key,
  type: 'number',
  ...(required ? { required } : {}),
  ...(description !== undefined ? { description } : {}),
});
const B = (key: string, description?: string): ActionParamDef => ({
  key,
  type: 'boolean',
  ...(description !== undefined ? { description } : {}),
});

export const ACTION_TOOL_SPECS: readonly ActionToolSpec[] = Object.freeze([
  // --- discrete (pointer/keyboard) ---
  { tool: 'pdl_click', action: 'click', params: [], summary: 'Click an element (full pointer/mouse event chain so React/Vue delegated onClick fires).' },
  { tool: 'pdl_dblclick', action: 'dblclick', params: [], summary: 'Double-click an element.' },
  { tool: 'pdl_fill', action: 'fill', params: [S('value', true, 'text to set')], summary: "Set an input/textarea/select value via the native setter + input/change (works with React controlled inputs)." },
  { tool: 'pdl_submit', action: 'submit', params: [], summary: 'Submit the form owning the located element (requestSubmit).' },
  { tool: 'pdl_hover', action: 'hover', params: [], summary: 'Hover an element (pointer/mouse over/enter/move).' },
  { tool: 'pdl_focus', action: 'focus', params: [], summary: 'Focus an element.' },
  { tool: 'pdl_blur', action: 'blur', params: [], summary: 'Blur an element.' },
  { tool: 'pdl_check', action: 'check', params: [], summary: 'Check a checkbox/radio (idempotent; native click path so onChange fires).' },
  { tool: 'pdl_uncheck', action: 'uncheck', params: [], summary: 'Uncheck a checkbox (idempotent).' },
  { tool: 'pdl_select_option', action: 'selectOption', params: [S('value', false, 'option value'), S('label', false, 'visible option label')], summary: 'Select a <select> option by value or visible label (one required).' },
  { tool: 'pdl_key_press', action: 'keyPress', params: [S('key', true, "a character or named key e.g. 'Enter','Tab','ArrowDown'")], summary: 'Press a single key on an element.' },
  { tool: 'pdl_type_sequence', action: 'typeSequence', params: [S('value', true, 'string to type char-by-char')], summary: 'Type a string into an editable element char-by-char.' },
  // --- gestures (pointer/touch) ---
  { tool: 'pdl_drag', action: 'drag', params: [N('toX', false, 'destination viewport X'), N('toY', false, 'destination viewport Y'), S('targetSelector', false, 'CSS selector for the drop target (alternative to toX/toY)'), N('steps', false, 'pointermove steps (default 10)'), B('html5', 'also fire the native HTML5 drag/drop sequence with a DataTransfer')], summary: 'Drag the located element to a point (toX/toY) or onto targetSelector; pointer drag + optional HTML5 DnD.' },
  { tool: 'pdl_scroll', action: 'scroll', params: [N('deltaX', false, 'horizontal scroll delta'), N('deltaY', false, 'vertical scroll delta'), B('intoView', 'scrollIntoView (centered) instead of by-delta')], summary: 'Scroll the located element by delta (dispatches wheel + scrollBy) or scrollIntoView.' },
  { tool: 'pdl_swipe', action: 'swipe', params: [{ key: 'direction', type: 'enum', required: true, enum: ['up', 'down', 'left', 'right'], description: 'swipe direction' }, N('distance', false, 'px distance (default 100)'), N('steps', false, 'touchmove steps (default 10)')], summary: 'Swipe a touch across the located element in a direction.' },
  { tool: 'pdl_tap', action: 'tap', params: [], summary: 'Tap (touchstart/touchend) the located element.' },
  { tool: 'pdl_double_tap', action: 'doubleTap', params: [], summary: 'Double-tap the located element.' },
  { tool: 'pdl_long_press', action: 'longPress', params: [N('duration', false, 'hold ms before release (default 500)')], summary: 'Long-press the located element (holds, then releases + contextmenu).' },
  { tool: 'pdl_pinch', action: 'pinch', params: [N('scale', true, 'target scale: >1 zoom in, <1 zoom out'), N('steps', false, 'touchmove steps (default 10)')], summary: 'Pinch-zoom on the located element with two touches.' },
]);
