import { describe, it, expect } from 'vitest';
import {
  serializeArgs,
  serializeValue,
  type SerializedTag,
} from '../../src/captures/serialize.js';

describe('serializeValue (single-value walker)', () => {
  it('passes primitives through', () => {
    const seen = new WeakSet<object>();
    expect(serializeValue(1, seen)).toBe(1);
    expect(serializeValue('a', seen)).toBe('a');
    expect(serializeValue(true, seen)).toBe(true);
    expect(serializeValue(null, seen)).toBe(null);
    expect(serializeValue(undefined, seen)).toBe(undefined);
  });

  it('stringifies non-finite numbers', () => {
    expect(serializeValue(Number.NaN, new WeakSet())).toBe('NaN');
    expect(serializeValue(Number.POSITIVE_INFINITY, new WeakSet())).toBe('Infinity');
  });

  it('tags functions', () => {
    const named = function foo() {};
    const tag = serializeValue(named, new WeakSet()) as SerializedTag;
    expect(tag).toEqual({ __type: 'Function', name: 'foo' });
    const anon = serializeValue(() => 0, new WeakSet()) as SerializedTag;
    expect((anon as { __type: string }).__type).toBe('Function');
  });

  it('tags errors with name + message + stack', () => {
    const err = new TypeError('boom');
    const tag = serializeValue(err, new WeakSet()) as SerializedTag;
    expect(tag).toMatchObject({
      __type: 'Error',
      name: 'TypeError',
      message: 'boom',
    });
    expect(typeof (tag as { stack?: string }).stack).toBe('string');
  });

  it('tags promises', () => {
    const p = Promise.resolve(1);
    expect(serializeValue(p, new WeakSet())).toEqual({ __type: 'Promise' });
  });

  it('tags DOM nodes when DOM is available (happy-dom)', () => {
    const div = document.createElement('div');
    div.id = 'main';
    const tag = serializeValue(div, new WeakSet()) as SerializedTag;
    expect(tag).toEqual({ __type: 'DOMNode', nodeName: 'DIV', id: 'main' });
  });

  it('omits id when DOM node has no id', () => {
    const span = document.createElement('span');
    const tag = serializeValue(span, new WeakSet()) as SerializedTag;
    expect(tag).toEqual({ __type: 'DOMNode', nodeName: 'SPAN' });
  });

  it('recurses into plain objects and arrays', () => {
    const out = serializeValue({ a: [1, { b: 2 }] }, new WeakSet());
    expect(out).toEqual({ a: [1, { b: 2 }] });
  });

  it('detects cycles and replaces with __type: Cycle', () => {
    const a: Record<string, unknown> = { x: 1 };
    a['self'] = a;
    const out = serializeValue(a, new WeakSet()) as Record<string, unknown>;
    expect(out['x']).toBe(1);
    expect(out['self']).toEqual({ __type: 'Cycle' });
  });

  it('handles cycles in arrays', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    const out = serializeValue(arr, new WeakSet()) as unknown[];
    expect(out[0]).toBe(1);
    expect(out[1]).toEqual({ __type: 'Cycle' });
  });

  it('handles bigint and symbol', () => {
    expect(serializeValue(BigInt(5), new WeakSet())).toBe('5n');
    expect(serializeValue(Symbol('s'), new WeakSet())).toBe('Symbol(s)');
  });
});

describe('serializeArgs (top-level + size cap)', () => {
  it('serializes each arg independently', () => {
    const r = serializeArgs(['hello', { x: 1 }, [1, 2]]);
    expect(r.truncated).toBe(false);
    expect(r.serialized).toEqual(['hello', { x: 1 }, [1, 2]]);
  });

  it('replaces oversized args with Truncated tag and sets truncated=true', () => {
    const big = 'x'.repeat(20_000);
    const r = serializeArgs([big, 'small'], { maxBytes: 16_384 });
    expect(r.truncated).toBe(true);
    expect((r.serialized[0] as { __type: string }).__type).toBe('Truncated');
    expect(r.serialized[1]).toBe('small');
  });

  it('respects custom maxBytes', () => {
    const r = serializeArgs(['hello world'], { maxBytes: 5 });
    expect(r.truncated).toBe(true);
    const tag = r.serialized[0] as { __type: string; max: number };
    expect(tag.__type).toBe('Truncated');
    expect(tag.max).toBe(5);
  });

  it('uses default 16KB cap when opts omitted', () => {
    const small = serializeArgs(['short string']);
    expect(small.truncated).toBe(false);
  });

  it('cycle within an arg does not crash JSON.stringify size check', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    const r = serializeArgs([a]);
    expect(r.truncated).toBe(false);
    expect(r.serialized[0]).toEqual({ self: { __type: 'Cycle' } });
  });
});
