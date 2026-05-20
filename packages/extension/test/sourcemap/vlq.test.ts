import { describe, it, expect } from 'vitest';
import { decodeVlqList } from '../../src/sourcemap/vlq.js';

describe('decodeVlqList', () => {
  it('decodes the empty string to an empty list', () => {
    const r = decodeVlqList('');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual([]);
  });

  it("'AAAA' decodes to [0,0,0,0]", () => {
    const r = decodeVlqList('AAAA');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual([0, 0, 0, 0]);
  });

  it("'C' decodes to 1 (small positive)", () => {
    const r = decodeVlqList('C');
    if (!r.ok) throw new Error(r.error);
    expect(r.values).toEqual([1]);
  });

  it("'D' decodes to -1 (small negative — sign bit set)", () => {
    const r = decodeVlqList('D');
    if (!r.ok) throw new Error(r.error);
    expect(r.values).toEqual([-1]);
  });

  it("'kF' decodes a multi-char positive (>= 16)", () => {
    // VLQ for 82: ((82 << 1) >> 5) high group + low group bits.
    // sanity-check that multi-char decodes parse continuation flag correctly.
    const r = decodeVlqList('kF');
    if (!r.ok) throw new Error(r.error);
    expect(r.values.length).toBe(1);
    expect(r.values[0]).toBeGreaterThan(15);
  });

  it('decodes multiple values in sequence', () => {
    // "AAAA,CAAC" pattern: 4 zeros, then 1,0,0,1
    const r = decodeVlqList('AACC');
    if (!r.ok) throw new Error(r.error);
    expect(r.values).toEqual([0, 0, 1, 1]);
  });

  it('returns ok:false for invalid characters', () => {
    const r = decodeVlqList('A!A');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false for truncated input (missing terminator)', () => {
    // 'g' has the continuation bit set; with no following char it's truncated.
    const r = decodeVlqList('g');
    expect(r.ok).toBe(false);
  });
});
