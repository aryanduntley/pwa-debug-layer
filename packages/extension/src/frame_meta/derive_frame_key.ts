import { safeUuid } from '../ids/safe_random_id.js';

const TOP_KEY = 'top';

const indexInParent = (win: Window, parent: Window): number => {
  const len = parent.frames.length;
  for (let i = 0; i < len; i++) {
    if (parent.frames[i] === win) return i;
  }
  return -1;
};

// Always namespaced with `cross_origin/` so a cross-origin frame key can
// never collide with a structural `top/...` key — the uuid source is the
// shared guarded generator.
const defaultFallback = (): string => `cross_origin/${safeUuid()}`;

export const deriveFrameKey = (
  win: Window,
  fallback: () => string = defaultFallback,
): string => {
  if (win === win.top) return TOP_KEY;

  const indices: number[] = [];
  let memoizedFallback: string | undefined;
  const cachedFallback = (): string => {
    if (memoizedFallback === undefined) memoizedFallback = fallback();
    return memoizedFallback;
  };

  let current: Window = win;
  try {
    while (current !== current.parent) {
      const parent = current.parent;
      const idx = indexInParent(current, parent);
      if (idx < 0) return cachedFallback();
      indices.push(idx);
      current = parent;
    }
  } catch {
    return cachedFallback();
  }

  indices.reverse();
  return `${TOP_KEY}/${indices.join('/')}`;
};
