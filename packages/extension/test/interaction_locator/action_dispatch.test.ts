import { describe, it, expect } from 'vitest';
import { readActionInput, runAction } from '../../src/interaction_locator/action_dispatch.js';

describe('readActionInput', () => {
  it('splits locator (snake->camel) from a generic typed params record', () => {
    const out = readActionInput({
      selector: '#x',
      stable_id: 'a',
      framework: 'react',
      nth: 2,
      require_unique: true,
      deltaY: 100,
      intoView: true,
      scale: 2,
    });
    expect(out).not.toBeNull();
    expect(out!.locator).toMatchObject({
      selector: '#x',
      stableId: 'a',
      framework: 'react',
      nth: 2,
      requireUnique: true,
    });
    expect(out!.params).toEqual({ deltaY: 100, intoView: true, scale: 2 });
  });

  it('returns null for a non-object payload', () => {
    expect(readActionInput(null)).toBeNull();
    expect(readActionInput('x')).toBeNull();
  });
});

describe('runAction (gestures)', () => {
  const mount = (html: string): void => {
    document.body.innerHTML = html;
  };

  it('scroll resolves the locator and applies the action', async () => {
    mount('<div id="d"></div>');
    const r = await runAction(document, 'scroll', { selector: '#d' }, { deltaY: 50 });
    expect('action' in r).toBe(true);
    if ('action' in r) {
      expect(r.action.acted).toBe(true);
      expect(r.action.action).toBe('scroll');
      expect(r.located.matchCount).toBe(1);
    }
  });

  it('tap resolves and acts on a located element', async () => {
    mount('<button id="b"></button>');
    const r = await runAction(document, 'tap', { selector: '#b' }, {});
    expect('action' in r && r.action.acted).toBe(true);
  });

  it('pinch requires a numeric scale', async () => {
    mount('<div id="d"></div>');
    const r = await runAction(document, 'pinch', { selector: '#d' }, {});
    expect('error' in r).toBe(true);
  });

  it('swipe requires a valid direction', async () => {
    mount('<div id="d"></div>');
    const r = await runAction(document, 'swipe', { selector: '#d' }, { direction: 'sideways' });
    expect('error' in r).toBe(true);
  });

  it('returns a locator error when nothing matches', async () => {
    mount('<div></div>');
    const r = await runAction(document, 'tap', { selector: '.none' }, {});
    expect('error' in r).toBe(true);
  });
});
