/**
 * Feature-detect Solid on the page. Solid exposes no stable runtime global, so
 * detection is best-effort and combines: (1) the @solid-devtools hook
 * window.__SOLID_DEVTOOLS__ (definitive, and the only path to deep data); (2)
 * the _$HY hydration global; (3) a heuristic scan for Solid's $$-prefixed
 * delegated-event expando props on DOM nodes. `present` may be true with
 * devtoolsHook:false, in which case only DOM-level matching is available.
 */
import {
  SOLID_DEVTOOLS_KEY,
  SOLID_HYDRATION_KEY,
  SOLID_DELEGATED_PREFIX,
  type SolidDetection,
} from './types.js';

type SolidScope = {
  readonly [SOLID_DEVTOOLS_KEY]?: unknown;
  readonly [SOLID_HYDRATION_KEY]?: unknown;
};

const hasKey = (scope: SolidScope, key: string): boolean => {
  try {
    return (scope as Record<string, unknown>)[key] != null;
  } catch {
    return false;
  }
};

/** True when an element carries any $$-prefixed delegated-event expando prop. */
const hasDelegatedEvent = (el: Element): boolean => {
  try {
    for (const k of Object.keys(el)) {
      if (k.startsWith(SOLID_DELEGATED_PREFIX)) return true;
    }
  } catch {
    // exotic element — ignore
  }
  return false;
};

const countDelegatedEventEls = (doc: Document): number => {
  let count = 0;
  let all: ArrayLike<Element>;
  try {
    all = doc.querySelectorAll('*');
  } catch {
    return 0;
  }
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el !== undefined && hasDelegatedEvent(el)) count += 1;
  }
  return count;
};

export const detectSolid = (
  scope: SolidScope,
  doc: Document,
): SolidDetection => {
  const devtoolsHook = hasKey(scope, SOLID_DEVTOOLS_KEY);
  const hydration = hasKey(scope, SOLID_HYDRATION_KEY);
  const delegatedEventCount = countDelegatedEventEls(doc);
  return Object.freeze({
    present: devtoolsHook || hydration || delegatedEventCount > 0,
    devtoolsHook,
    hydration,
    delegatedEventCount,
  });
};
