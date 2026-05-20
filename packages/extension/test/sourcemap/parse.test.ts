import { describe, it, expect } from 'vitest';
import { parseSourceMap } from '../../src/sourcemap/parse.js';

describe('parseSourceMap — validation', () => {
  it('returns null for non-objects', () => {
    expect(parseSourceMap(null)).toBeNull();
    expect(parseSourceMap('not-an-object')).toBeNull();
    expect(parseSourceMap(42)).toBeNull();
  });

  it('rejects version !== 3', () => {
    expect(parseSourceMap({ version: 2, sources: [], mappings: '' })).toBeNull();
  });

  it('rejects when sources is not a string array', () => {
    expect(parseSourceMap({ version: 3, sources: 'oops', mappings: '' })).toBeNull();
    expect(
      parseSourceMap({ version: 3, sources: ['a', 42], mappings: '' }),
    ).toBeNull();
  });

  it('rejects when mappings is not a string', () => {
    expect(parseSourceMap({ version: 3, sources: [], mappings: 0 })).toBeNull();
  });

  it('accepts minimal valid map (empty mappings)', () => {
    const r = parseSourceMap({
      version: 3,
      sources: ['a.ts'],
      mappings: '',
    });
    expect(r).not.toBeNull();
    expect(r?.lines).toEqual([[]]);
  });
});

describe('parseSourceMap — mappings decode', () => {
  it('decodes a single 1-field segment (column-only marker)', () => {
    // 'A' → genCol delta 0; single-field segment
    const r = parseSourceMap({
      version: 3,
      sources: ['a.ts'],
      mappings: 'A',
    });
    expect(r?.lines[0]).toEqual([{ genCol: 0 }]);
  });

  it('decodes a 4-field segment (source/origLine/origCol)', () => {
    // 'AAAA' → [0,0,0,0]
    const r = parseSourceMap({
      version: 3,
      sources: ['a.ts'],
      mappings: 'AAAA',
    });
    expect(r?.lines[0]).toEqual([
      { genCol: 0, sourceIdx: 0, origLine: 0, origCol: 0 },
    ]);
  });

  it('decodes multi-line mappings with delta unrolling across lines', () => {
    // line 0: AAAA  → genCol 0, source 0, origLine 0, origCol 0
    // line 1: empty
    // line 2: AAAA  → genCol 0, source still 0, origLine 0 (delta 0), origCol 0
    const r = parseSourceMap({
      version: 3,
      sources: ['a.ts'],
      mappings: 'AAAA;;AAAA',
    });
    expect(r?.lines.length).toBe(3);
    expect(r?.lines[0]?.length).toBe(1);
    expect(r?.lines[1]?.length).toBe(0);
    expect(r?.lines[2]?.length).toBe(1);
  });

  it('decodes multiple segments on one line (genCol resets per line)', () => {
    // 'AAAA,CAAC' → seg0=(0,0,0,0); seg1=(1,0,0,1) after delta
    const r = parseSourceMap({
      version: 3,
      sources: ['a.ts'],
      mappings: 'AAAA,CAAC',
    });
    expect(r?.lines[0]?.length).toBe(2);
    expect(r?.lines[0]?.[0]).toEqual({
      genCol: 0,
      sourceIdx: 0,
      origLine: 0,
      origCol: 0,
    });
    expect(r?.lines[0]?.[1]).toEqual({
      genCol: 1,
      sourceIdx: 0,
      origLine: 0,
      origCol: 1,
    });
  });
});
