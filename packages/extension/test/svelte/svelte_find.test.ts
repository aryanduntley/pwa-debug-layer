import { describe, it, expect, afterEach } from 'vitest';
import { SVELTE_META_KEY } from '../../src/svelte/types.js';
import { findSvelteByText } from '../../src/svelte/find_by_text.js';
import { findSvelteByRole } from '../../src/svelte/find_by_role.js';
import {
  svelteComponentsHandler,
  svelteFindByTextHandler,
  svelteFindByRoleHandler,
} from '../../src/page_bridge/page_dispatch.js';
import type { PageBridgeRequestEnvelope } from '../../src/page_bridge/protocol.js';

const tag = (el: Element, file: string): void => {
  (el as unknown as Record<string, unknown>)[SVELTE_META_KEY] = { loc: { file } };
};

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
});

const env = (payload: unknown): PageBridgeRequestEnvelope =>
  ({ requestId: 'r', tool: 't', payload }) as PageBridgeRequestEnvelope;

describe('findSvelteByText', () => {
  it('matches by text and dedupes per component file', () => {
    mount((r) => {
      tag(r, 'src/App.svelte');
      const a = document.createElement('span');
      tag(a, 'src/Counter.svelte');
      a.textContent = 'Count: 1';
      const b = document.createElement('span');
      tag(b, 'src/Counter.svelte');
      b.textContent = 'Count: 2';
      r.append(a, b);
    });
    const res = findSvelteByText(document, /Count/);
    const counter = res.matches.filter((m) => m.file === 'src/Counter.svelte');
    expect(counter).toHaveLength(1);
    expect(counter[0]!.stableId).toBe('src/Counter.svelte');
    expect(counter[0]!.matchedText).toBe('Count');
  });
});

describe('findSvelteByRole', () => {
  it('matches by role + accessible name', () => {
    mount((r) => {
      tag(r, 'src/App.svelte');
      const btn = document.createElement('button');
      tag(btn, 'src/Counter.svelte');
      btn.textContent = 'Increment';
      r.append(btn);
    });
    const res = findSvelteByRole(document, 'button', /Increment/);
    expect(res.matches.some((m) => m.file === 'src/Counter.svelte' && m.role === 'button')).toBe(true);
    expect(findSvelteByRole(document, 'button', /Nope/).matches).toHaveLength(0);
  });
});

describe('svelte page-world handlers', () => {
  it('svelteComponentsHandler reports detection + components', () => {
    mount((r) => {
      const el = document.createElement('span');
      tag(el, 'src/App.svelte');
      r.append(el);
    });
    const res = svelteComponentsHandler();
    expect(res.present).toBe(true);
    expect(res.dev).toBe(true);
    expect(res.components.some((c) => c.file === 'src/App.svelte')).toBe(true);
  });

  it('find handlers shape errors for bad payloads / invalid regex', () => {
    expect('error' in svelteFindByTextHandler(env({}))).toBe(true);
    const badText = svelteFindByTextHandler(env({ pattern: '(' }));
    expect('error' in badText).toBe(true);
    if ('error' in badText) expect(badText.error.message).toContain('invalid regex');
    expect('error' in svelteFindByRoleHandler(env({}))).toBe(true);
    const badRole = svelteFindByRoleHandler(env({ role: 'button', name: '(' }));
    expect('error' in badRole).toBe(true);
    if ('error' in badRole) expect(badRole.error.message).toContain('invalid name regex');
  });
});
