/**
 * React fiber-tree Context-value collector.
 *
 * Walks every React root's committed fiber tree and returns the `value` held by
 * each Context provider fiber — i.e. whatever an app passed to
 * `<SomeContext.Provider value={…}>` (React ≤18) or `<SomeContext value={…}>`
 * (React 19). This is the passive, read-only foundation for zero-config store
 * discovery: store libraries that integrate with React keep their store on a
 * context (react-redux's ReactReduxContext value carries `{ store }`; Jotai's
 * Provider context value IS the createStore() instance), so store adapters
 * duck-type these collected values rather than our extension ever sitting in
 * the app's store-creation path.
 *
 * Pure: DOM reads + fiber reads only (no chrome.*, no mutation).
 */
import { findReactRoots } from './find_react_roots.js';
import { getRootFiber } from './get_root_fiber.js';
import { walkFiber } from './walk_fiber.js';
import type { Fiber } from './types.js';

// Provider identity across React majors. React ≤18 renders a Provider whose
// `fiber.type` is the provider object ($$typeof === react.provider, with a
// `_context` back-reference). React 19 lets `<Context>` itself be the provider,
// so `fiber.type` carries $$typeof === react.context. Matching on these symbols
// (plus the `_context` shape) is version-resilient where tag numbers are not.
const PROVIDER = Symbol.for('react.provider');
const CONTEXT = Symbol.for('react.context');

const isContextProviderType = (type: unknown): boolean => {
  if (type === null || typeof type !== 'object') return false;
  const t = type as { $$typeof?: unknown; _context?: unknown };
  return (
    t.$$typeof === PROVIDER ||
    t.$$typeof === CONTEXT ||
    t._context !== undefined
  );
};

// The context value lives on the provider fiber's memoizedProps.value. Only
// object values can be a store, so non-objects are skipped at the source.
const providerObjectValue = (fiber: Fiber): object | null => {
  if (!isContextProviderType(fiber.type)) return null;
  const props = fiber.memoizedProps;
  if (props === null || typeof props !== 'object') return null;
  const value = (props as { value?: unknown }).value;
  return value !== null && typeof value === 'object' ? value : null;
};

/**
 * Collect the object-typed context `value` of every Context provider fiber
 * across all React roots in `doc`, in tree order and de-duplicated by reference.
 * Callers duck-type the results for the store shape they recognize (react-redux
 * `{ store }`, Jotai store, …). Returns [] when no React roots or providers are
 * present.
 */
export const collectContextValues = (doc: Document): object[] => {
  const seen = new Set<object>();
  const out: object[] = [];
  for (const rootEl of findReactRoots(doc)) {
    const root = getRootFiber(rootEl);
    if (root === undefined) continue;
    walkFiber(root, (fiber) => {
      const value = providerObjectValue(fiber);
      if (value !== null && !seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    });
  }
  return out;
};
