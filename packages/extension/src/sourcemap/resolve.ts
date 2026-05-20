/**
 * Given a ParsedMap and a (generated line, generated column) pair, find the
 * original source location by binary-searching the segments of the matching
 * generated line for the largest genCol <= the requested column.
 *
 * Inputs use 1-based generated lines (stack traces use 1-based) and 0-based
 * generated columns (V8 convention). Outputs return 1-based original lines
 * and 0-based original columns (same as DevTools).
 *
 * Pure.
 */
import type { ParsedMap, ParsedSegment } from './parse.js';

export type ResolvedFrame = {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly name?: string;
};

const findSegment = (
  segs: readonly ParsedSegment[],
  col: number,
): ParsedSegment | undefined => {
  if (segs.length === 0) return undefined;
  let lo = 0;
  let hi = segs.length - 1;
  let best: ParsedSegment | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = segs[mid] as ParsedSegment;
    if (seg.genCol <= col) {
      best = seg;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
};

export const resolveLocation = (
  map: ParsedMap,
  line: number,
  column: number,
): ResolvedFrame | null => {
  if (!Number.isInteger(line) || line < 1) return null;
  if (!Number.isInteger(column) || column < 0) return null;
  const lineIdx = line - 1;
  if (lineIdx >= map.lines.length) return null;
  const segs = map.lines[lineIdx] as readonly ParsedSegment[] | undefined;
  if (segs === undefined) return null;
  const seg = findSegment(segs, column);
  if (seg === undefined) return null;
  if (
    seg.sourceIdx === undefined ||
    seg.origLine === undefined ||
    seg.origCol === undefined
  ) {
    return null;
  }
  const source = map.sources[seg.sourceIdx];
  if (source === undefined) return null;
  const out: {
    source: string;
    line: number;
    column: number;
    name?: string;
  } = {
    source,
    line: seg.origLine + 1, // sourcemaps are 0-based original lines
    column: seg.origCol,
  };
  if (seg.nameIdx !== undefined) {
    const name = map.names[seg.nameIdx];
    if (name !== undefined) out.name = name;
  }
  return Object.freeze(out);
};
