import { describe, it, expect } from 'vitest';
import { getValueAtPath } from '../../../src/stores/redux/path_get.js';

describe('getValueAtPath — identity', () => {
  it('undefined path returns the root unchanged', () => {
    const root = { counter: { value: 3 } };
    const r = getValueAtPath(root, undefined);
    expect(r).toEqual({ ok: true, value: root });
  });

  it('empty path string returns the root', () => {
    const root = { counter: { value: 3 } };
    const r = getValueAtPath(root, '');
    expect(r).toEqual({ ok: true, value: root });
  });
});

describe('getValueAtPath — dot notation', () => {
  it("'a' reads a top-level property", () => {
    const r = getValueAtPath({ a: 42 }, 'a');
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it("'a.b' reads a nested property", () => {
    const r = getValueAtPath({ a: { b: 'hi' } }, 'a.b');
    expect(r).toEqual({ ok: true, value: 'hi' });
  });

  it('returns undefined for missing properties (consistent with JS)', () => {
    const r = getValueAtPath({ a: {} }, 'a.b');
    expect(r).toEqual({ ok: true, value: undefined });
  });
});

describe('getValueAtPath — bracket notation', () => {
  it("'a[0]' reads an array index", () => {
    const r = getValueAtPath({ a: ['x', 'y'] }, 'a[0]');
    expect(r).toEqual({ ok: true, value: 'x' });
  });

  it("'a[1].b' chains bracket then dot", () => {
    const r = getValueAtPath({ a: [{}, { b: 7 }] }, 'a[1].b');
    expect(r).toEqual({ ok: true, value: 7 });
  });

  it("\"a['key']\" reads a quoted-string key", () => {
    const r = getValueAtPath({ a: { 'k-name': 'ok' } }, "a['k-name']");
    expect(r).toEqual({ ok: true, value: 'ok' });
  });

  it('a["key"] reads a double-quoted key', () => {
    const r = getValueAtPath({ a: { 'k name': 'yes' } }, 'a["k name"]');
    expect(r).toEqual({ ok: true, value: 'yes' });
  });

  it('out-of-range array index returns undefined (consistent with JS)', () => {
    const r = getValueAtPath({ a: ['x'] }, 'a[5]');
    expect(r).toEqual({ ok: true, value: undefined });
  });
});

describe('getValueAtPath — malformed paths', () => {
  it('leading dot is rejected', () => {
    const r = getValueAtPath({}, '.a');
    expect(r.ok).toBe(false);
  });

  it('trailing dot is rejected', () => {
    const r = getValueAtPath({}, 'a.');
    expect(r.ok).toBe(false);
  });

  it('unclosed bracket is rejected', () => {
    const r = getValueAtPath({}, 'a[0');
    expect(r.ok).toBe(false);
  });

  it('empty bracket is rejected', () => {
    const r = getValueAtPath({}, 'a[]');
    expect(r.ok).toBe(false);
  });

  it('non-integer / unquoted bracket content is rejected', () => {
    const r = getValueAtPath({}, 'a[bare]');
    expect(r.ok).toBe(false);
  });

  it('numeric prefix on bare name is rejected', () => {
    const r = getValueAtPath({}, '0a');
    expect(r.ok).toBe(false);
  });
});

describe('getValueAtPath — descent through primitives', () => {
  it('descending through null fails', () => {
    const r = getValueAtPath({ a: null }, 'a.b');
    expect(r.ok).toBe(false);
  });

  it('descending through a number fails', () => {
    const r = getValueAtPath({ a: 7 }, 'a.b');
    expect(r.ok).toBe(false);
  });

  it('descending through a string fails', () => {
    const r = getValueAtPath({ a: 'x' }, 'a.b');
    expect(r.ok).toBe(false);
  });
});
