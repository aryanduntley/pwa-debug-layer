import { describe, it, expect, vi } from 'vitest';
import { makeMouseEvent, dispatchAll } from '../../src/dom_actions/events.js';
import { clickElement, dblclickElement } from '../../src/dom_actions/click.js';
import { fillElement } from '../../src/dom_actions/fill.js';
import { submitForm } from '../../src/dom_actions/submit.js';
import { setChecked, selectOption } from '../../src/dom_actions/toggle_select.js';
import { pressKey, typeSequence } from '../../src/dom_actions/keyboard.js';
import { hoverElement, focusElement } from '../../src/dom_actions/hover_focus.js';

const mount = (html: string): void => {
  document.body.innerHTML = html;
};

describe('events', () => {
  it('builds bubbling, cancelable, composed events by default', () => {
    const ev = makeMouseEvent('click');
    expect(ev.bubbles).toBe(true);
    expect(ev.cancelable).toBe(true);
    expect(ev.composed).toBe(true);
  });

  it('dispatchAll reports defaultPrevented when a listener cancels', () => {
    const el = document.createElement('div');
    el.addEventListener('click', (e) => e.preventDefault());
    expect(dispatchAll(el, [makeMouseEvent('click')]).defaultPrevented).toBe(true);
    expect(dispatchAll(el, [makeMouseEvent('mousedown')]).defaultPrevented).toBe(false);
  });
});

describe('clickElement', () => {
  it('fires a bubbling click and the mousedown phase', () => {
    mount('<button id="b">Go</button>');
    const btn = document.getElementById('b')!;
    const click = vi.fn();
    const mousedown = vi.fn();
    btn.addEventListener('click', click);
    btn.addEventListener('mousedown', mousedown);
    const res = clickElement(btn);
    expect(res.acted).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(mousedown).toHaveBeenCalledTimes(1);
  });

  it('dblclick fires two clicks and a dblclick', () => {
    mount('<button id="b">Go</button>');
    const btn = document.getElementById('b')!;
    const click = vi.fn();
    const dbl = vi.fn();
    btn.addEventListener('click', click);
    btn.addEventListener('dblclick', dbl);
    dblclickElement(btn);
    expect(click).toHaveBeenCalledTimes(2);
    expect(dbl).toHaveBeenCalledTimes(1);
  });
});

describe('fillElement', () => {
  it('sets the value and fires input + change', () => {
    mount('<input id="i" />');
    const input = document.getElementById('i') as HTMLInputElement;
    const input_ev = vi.fn();
    const change = vi.fn();
    input.addEventListener('input', input_ev);
    input.addEventListener('change', change);
    const res = fillElement(input, 'hello');
    expect(res.acted).toBe(true);
    expect(input.value).toBe('hello');
    expect(input_ev).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('fails on a non-fillable element', () => {
    mount('<div id="d"></div>');
    const res = fillElement(document.getElementById('d')!, 'x');
    expect(res.acted).toBe(false);
  });
});

describe('submitForm', () => {
  it('triggers a submit listener via the owning form', () => {
    mount('<form id="f"><input name="q" /><button id="s">go</button></form>');
    const form = document.getElementById('f') as HTMLFormElement;
    const submit = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submit);
    const res = submitForm(document.getElementById('s')!);
    expect(res.acted).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('setChecked', () => {
  it('toggles a checkbox, fires change, and is idempotent', () => {
    mount('<input id="c" type="checkbox" />');
    const box = document.getElementById('c') as HTMLInputElement;
    const change = vi.fn();
    box.addEventListener('change', change);

    const r1 = setChecked(box, true);
    expect(box.checked).toBe(true);
    expect(r1.detail).toMatchObject({ changed: true });
    expect(change).toHaveBeenCalledTimes(1);

    const r2 = setChecked(box, true);
    expect(r2.detail).toMatchObject({ changed: false });
    expect(change).toHaveBeenCalledTimes(1);
  });
});

describe('selectOption', () => {
  it('selects by value and by label, and fails on no match', () => {
    mount('<select id="s"><option value="a">Apple</option><option value="b">Banana</option></select>');
    const sel = document.getElementById('s') as HTMLSelectElement;
    expect(selectOption(sel, { value: 'b' }).acted).toBe(true);
    expect(sel.value).toBe('b');
    expect(selectOption(sel, { label: 'Apple' }).acted).toBe(true);
    expect(sel.value).toBe('a');
    expect(selectOption(sel, { value: 'zzz' }).acted).toBe(false);
  });
});

describe('keyboard', () => {
  it('pressKey dispatches keydown/keyup for a named key', () => {
    mount('<input id="i" />');
    const input = document.getElementById('i')!;
    const down = vi.fn();
    input.addEventListener('keydown', down);
    const res = pressKey(input, 'Enter');
    expect(res.acted).toBe(true);
    expect(down).toHaveBeenCalledTimes(1);
    expect((down.mock.calls[0]![0] as KeyboardEvent).key).toBe('Enter');
  });

  it('typeSequence builds the value and fires input per char + a final change', () => {
    mount('<input id="i" />');
    const input = document.getElementById('i') as HTMLInputElement;
    const input_ev = vi.fn();
    const change = vi.fn();
    input.addEventListener('input', input_ev);
    input.addEventListener('change', change);
    const res = typeSequence(input, 'hi');
    expect(res.acted).toBe(true);
    expect(input.value).toBe('hi');
    expect(input_ev).toHaveBeenCalledTimes(2);
    expect(change).toHaveBeenCalledTimes(1);
  });
});

describe('hover + focus', () => {
  it('hover fires mouseover; focus focuses and fires focusin', () => {
    mount('<div id="d"></div><input id="i" />');
    const div = document.getElementById('d')!;
    const over = vi.fn();
    div.addEventListener('mouseover', over);
    expect(hoverElement(div).acted).toBe(true);
    expect(over).toHaveBeenCalledTimes(1);

    const input = document.getElementById('i') as HTMLInputElement;
    const focusin = vi.fn();
    input.addEventListener('focusin', focusin);
    expect(focusElement(input).acted).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(focusin).toHaveBeenCalledTimes(1);
  });
});
