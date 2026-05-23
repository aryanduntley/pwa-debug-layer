import { describe, it, expect, afterEach } from 'vitest';
import { SOLID_DEVTOOLS_KEY, SOLID_HYDRATION_KEY } from '../../src/solid/types.js';
import { detectSolid } from '../../src/solid/detect.js';
import { elementLocator } from '../../src/solid/find.js';
import { findSolidByText } from '../../src/solid/find_by_text.js';
import { findSolidByRole } from '../../src/solid/find_by_role.js';
import {
  solidDetectHandler,
  solidFindByTextHandler,
  solidFindByRoleHandler,
} from '../../src/page_bridge/page_dispatch.js';
import type { PageBridgeRequestEnvelope } from '../../src/page_bridge/protocol.js';

const roots: HTMLElement[] = [];
const mount = (build: (r: HTMLElement) => void): HTMLElement => {
  const r = document.createElement('div');
  build(r);
  document.body.appendChild(r);
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
  delete (globalThis as unknown as Record<string, unknown>)[SOLID_DEVTOOLS_KEY];
  delete (globalThis as unknown as Record<string, unknown>)[SOLID_HYDRATION_KEY];
});

const env = (payload: unknown): PageBridgeRequestEnvelope =>
  ({ requestId: 'r', tool: 't', payload }) as PageBridgeRequestEnvelope;

describe('detectSolid', () => {
  it('detects the @solid-devtools hook', () => {
    (globalThis as unknown as Record<string, unknown>)[SOLID_DEVTOOLS_KEY] = {};
    const d = detectSolid(globalThis as never, document);
    expect(d.present).toBe(true);
    expect(d.devtoolsHook).toBe(true);
  });

  it('detects $$-delegated-event expando props heuristically', () => {
    mount((r) => {
      const btn = document.createElement('button');
      (btn as unknown as Record<string, unknown>)['$$click'] = () => undefined;
      r.append(btn);
    });
    const d = detectSolid({}, document);
    expect(d.present).toBe(true);
    expect(d.devtoolsHook).toBe(false);
    expect(d.delegatedEventCount).toBeGreaterThanOrEqual(1);
  });

  it('reports absent on a plain page', () => {
    expect(detectSolid({}, document)).toEqual({
      present: false,
      devtoolsHook: false,
      hydration: false,
      delegatedEventCount: 0,
    });
  });
});

describe('elementLocator', () => {
  it('prefers id, else tag.class with nth-of-type for siblings', () => {
    const root = mount((r) => {
      const withId = document.createElement('div');
      withId.id = 'main';
      const a = document.createElement('span');
      a.className = 'item x';
      const b = document.createElement('span');
      b.className = 'item';
      r.append(withId, a, b);
    });
    expect(elementLocator(root.querySelector('#main')!)).toBe('div#main');
    const spans = root.querySelectorAll('span');
    expect(elementLocator(spans[0]!)).toBe('span.item:nth-of-type(1)');
    expect(elementLocator(spans[1]!)).toBe('span.item:nth-of-type(2)');
  });
});

describe('findSolidByText / findSolidByRole', () => {
  it('returns element-level matches with locator + tag', () => {
    mount((r) => {
      const p = document.createElement('p');
      p.textContent = 'Hello Solid';
      const btn = document.createElement('button');
      btn.textContent = 'Click';
      r.append(p, btn);
    });
    const text = findSolidByText(document, /Solid/);
    expect(text.matches.some((m) => m.tag === 'p' && m.matchedText === 'Solid')).toBe(true);
    const role = findSolidByRole(document, 'button', /Click/);
    expect(role.matches.some((m) => m.tag === 'button' && m.role === 'button')).toBe(true);
  });
});

describe('solid page-world handlers', () => {
  it('solidDetectHandler returns detection + scopeUrl', () => {
    const res = solidDetectHandler();
    expect(typeof res.present).toBe('boolean');
    expect(typeof res.scopeUrl).toBe('string');
  });

  it('find handlers shape errors for bad payloads / invalid regex', () => {
    expect('error' in solidFindByTextHandler(env({}))).toBe(true);
    const badText = solidFindByTextHandler(env({ pattern: '(' }));
    expect('error' in badText).toBe(true);
    if ('error' in badText) expect(badText.error.message).toContain('invalid regex');
    expect('error' in solidFindByRoleHandler(env({}))).toBe(true);
    const badRole = solidFindByRoleHandler(env({ role: 'button', name: '(' }));
    if ('error' in badRole) expect(badRole.error.message).toContain('invalid name regex');
  });
});
