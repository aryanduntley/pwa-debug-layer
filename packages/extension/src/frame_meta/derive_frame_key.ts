const TOP_KEY = 'top';

const indexInParent = (win: Window, parent: Window): number => {
  const len = parent.frames.length;
  for (let i = 0; i < len; i++) {
    if (parent.frames[i] === win) return i;
  }
  return -1;
};

const defaultFallback = (): string => {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `cross_origin/${uuid}`;
};

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
