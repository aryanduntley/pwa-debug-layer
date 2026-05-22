/**
 * Store-adapter registry + multi-store detection orchestrator. Holds the
 * ordered list of registered StoreAdapters and resolves the live store on a
 * page by trying each adapter's detect() in priority order, returning the
 * first match.
 *
 * Order matters: Redux is tried first because its devtools shim is the most
 * specific (a Redux-shaped store with a dispatch and a reducer). Zustand's
 * devtools middleware reuses the SAME __REDUX_DEVTOOLS_EXTENSION__ hook, so
 * when the Zustand adapter lands (M3) it must disambiguate rather than rely on
 * ordering alone — see the M3 adapter for that logic.
 *
 * Pure aside from the module-level adapter list, which is fixed at import time
 * (adapters are registered by static import here, not at runtime), keeping
 * detectStore itself referentially transparent for a given (scope, ctx).
 */
import type {
  DetectContext,
  DetectedStore,
  StoreAdapter,
} from './contract.js';
import { reduxAdapter } from './redux/adapter.js';
import { zustandAdapter } from './zustand/adapter.js';
import { piniaAdapter } from './pinia/adapter.js';
import { jotaiAdapter } from './jotai/adapter.js';

/**
 * Registered adapters in detection priority order; callers never change.
 * Adapters never collide: each uses a distinct explicit-handoff key
 * (__pwaDebug_redux / _zustand / _pinia / _jotai) and a mutually exclusive
 * duck-type (Redux requires dispatch, Zustand requires setState, Pinia requires
 * the $-prefixed surface, Jotai requires the wrapped { store, atoms } shape).
 */
export const STORE_ADAPTERS: readonly StoreAdapter[] = Object.freeze([
  reduxAdapter,
  zustandAdapter,
  piniaAdapter,
  jotaiAdapter,
]);

/**
 * Try each registered adapter against the scope in priority order. Returns the
 * first { framework, handle } whose detect() yields a store, or null when no
 * registered framework's store is present.
 *
 * When `framework` is supplied, only the adapter with that framework tag is
 * consulted (explicit selection from the store_* tool's framework arg); an
 * unknown framework tag yields null.
 */
export const detectStore = (
  scope: unknown,
  ctx?: DetectContext,
  framework?: string,
): DetectedStore | null => {
  const candidates =
    framework === undefined
      ? STORE_ADAPTERS
      : STORE_ADAPTERS.filter((a) => a.framework === framework);
  for (const adapter of candidates) {
    const handle = adapter.detect(scope, ctx);
    if (handle !== null) {
      return Object.freeze({ framework: adapter.framework, handle });
    }
  }
  return null;
};
