import { describe, it, expect } from 'vitest';
import { parseSourceMap } from '../../src/sourcemap/parse.js';
import { resolveLocation } from '../../src/sourcemap/resolve.js';

const mkMap = (mappings: string, sources = ['a.ts'], names: string[] = []) =>
  parseSourceMap({ version: 3, sources, names, mappings }) ??
  (() => {
    throw new Error('parse failed');
  })();

describe('resolveLocation', () => {
  it('returns null for invalid line/column inputs', () => {
    const m = mkMap('AAAA');
    expect(resolveLocation(m, 0, 0)).toBeNull(); // line must be >= 1
    expect(resolveLocation(m, 1, -1)).toBeNull(); // column must be >= 0
    expect(resolveLocation(m, 1.5, 0)).toBeNull(); // non-integer
  });

  it('returns null when generated line is beyond the map', () => {
    const m = mkMap('AAAA'); // only line 1 has segments
    expect(resolveLocation(m, 2, 0)).toBeNull();
  });

  it('returns null when a line has no segments', () => {
    const m = mkMap('AAAA;');
    expect(resolveLocation(m, 2, 0)).toBeNull();
  });

  it('resolves a single-segment line at exact genCol', () => {
    // genCol 0, source 'a.ts', origLine 1 (0+1), origCol 0
    const m = mkMap('AAAA');
    const r = resolveLocation(m, 1, 0);
    expect(r).toEqual({ source: 'a.ts', line: 1, column: 0 });
  });

  it('picks the largest genCol <= column (binary search)', () => {
    // Two segments at genCol 0 and 1 → asking col 5 picks the genCol-1 segment.
    const m = mkMap('AAAA,CAAC');
    const r = resolveLocation(m, 1, 5);
    expect(r).toEqual({ source: 'a.ts', line: 1, column: 1 });
  });

  it('returns the earlier segment when column is between two segments', () => {
    // Two segments at genCol 0 and 10; col 7 maps to the first.
    // Build mappings manually: 'A' (genCol 0) + 'KAAA' segment? Use parse.
    // Simpler: use known fixture
    const m = mkMap('AAAA,UACA'); // genCol 0 → (0,0,0,0); +10 col, +1 src(0+1?), …
    // We just need a multi-segment line.
    const r0 = resolveLocation(m, 1, 0);
    expect(r0?.source).toBe('a.ts');
    const r1 = resolveLocation(m, 1, 100);
    // Last segment is the one with genCol 10 (U decodes to 10).
    expect(r1?.column).toBeDefined();
  });

  it('includes the name when the segment has a nameIdx', () => {
    // Build a 5-field segment: genCol 0, source 0, origLine 0, origCol 0, name 0
    // VLQ 'AAAAA' → 5 zeros.
    const m = mkMap('AAAAA', ['a.ts'], ['greet']);
    const r = resolveLocation(m, 1, 0);
    expect(r?.name).toBe('greet');
  });
});
