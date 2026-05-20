/**
 * Source Map v3 parser. Validates root structure, pre-decodes the mappings
 * string into per-generated-line sorted segments so resolveLocation only
 * needs a binary search.
 *
 * Pure: input is a JSON-parsed unknown; output is the pre-computed structure
 * (or null on validation failure). No fetch, no fs.
 */
import { decodeVlqList } from './vlq.js';

export type ParsedSegment = {
  readonly genCol: number;
  readonly sourceIdx?: number;
  readonly origLine?: number;
  readonly origCol?: number;
  readonly nameIdx?: number;
};

export type ParsedMap = {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly names: readonly string[];
  /** One entry per generated line (0-indexed). Each entry is sorted by genCol asc. */
  readonly lines: readonly (readonly ParsedSegment[])[];
};

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

export const parseSourceMap = (raw: unknown): ParsedMap | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 3) return null;
  if (!isStringArray(r['sources'])) return null;
  if (typeof r['mappings'] !== 'string') return null;
  const names = isStringArray(r['names']) ? r['names'] : [];
  const sources = r['sources'];
  const mappings = r['mappings'];

  const lines: ParsedSegment[][] = [];
  // Delta accumulators across the whole map for source/origLine/origCol/name;
  // reset across lines is NOT done for genCol — genCol resets per line.
  let prevSourceIdx = 0;
  let prevOrigLine = 0;
  let prevOrigCol = 0;
  let prevNameIdx = 0;

  for (const lineStr of mappings.split(';')) {
    const segments: ParsedSegment[] = [];
    let prevGenCol = 0;
    if (lineStr.length > 0) {
      for (const segStr of lineStr.split(',')) {
        if (segStr.length === 0) continue;
        const decoded = decodeVlqList(segStr);
        if (!decoded.ok) return null;
        const v = decoded.values;
        if (v.length === 0) continue;
        const genCol = prevGenCol + (v[0] ?? 0);
        prevGenCol = genCol;
        if (v.length === 1) {
          segments.push({ genCol });
          continue;
        }
        if (v.length < 4) return null; // segments are 1, 4, or 5 fields
        const sourceIdx = prevSourceIdx + (v[1] ?? 0);
        const origLine = prevOrigLine + (v[2] ?? 0);
        const origCol = prevOrigCol + (v[3] ?? 0);
        prevSourceIdx = sourceIdx;
        prevOrigLine = origLine;
        prevOrigCol = origCol;
        if (v.length === 5) {
          const nameIdx = prevNameIdx + (v[4] ?? 0);
          prevNameIdx = nameIdx;
          segments.push({ genCol, sourceIdx, origLine, origCol, nameIdx });
        } else {
          segments.push({ genCol, sourceIdx, origLine, origCol });
        }
      }
    }
    lines.push(segments);
  }

  return Object.freeze({
    version: 3 as const,
    sources: Object.freeze([...sources]),
    names: Object.freeze([...names]),
    lines: Object.freeze(lines.map((l) => Object.freeze(l))),
  });
};
