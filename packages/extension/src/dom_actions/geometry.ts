// Pure geometry helpers for pointer/touch gesture paths.

export type Point = { readonly x: number; readonly y: number };

/**
 * Center point of an element via getBoundingClientRect. Falls back to {0,0}
 * when layout is unavailable (no-layout test engines return all-zero rects).
 */
export const centerOf = (el: Element): Point => {
  const r = el.getBoundingClientRect?.();
  if (!r) return { x: 0, y: 0 };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/**
 * Linear interpolation from `from` to `to` over `steps` segments, returning
 * steps+1 points inclusive of both endpoints (for smooth move sequences).
 * steps<=0 yields just the endpoint.
 */
export const interpolatePoints = (from: Point, to: Point, steps: number): Point[] => {
  if (steps <= 0) return [to];
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return out;
};
