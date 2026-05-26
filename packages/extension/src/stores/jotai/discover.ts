/**
 * Page-world Jotai auto-discovery — finds live Jotai stores WITHOUT the explicit
 * window.__pwaDebug_jotai handoff (M44), by reading them PASSIVELY from the
 * React fiber tree.
 *
 * How: Jotai's `<Provider store={store}>` puts the createStore() instance ON the
 * Provider's React context — and the context value IS that store ({ get, set,
 * sub }), unlike react-redux which wraps it as `{ store }`. So we collect every
 * React context value (react/collect_context_values, shared with the redux
 * discoverer) and duck-type each for the bare Jotai store surface.
 *
 * Limitation: a Jotai app that uses the module-internal DEFAULT store (no
 * <Provider store>) keeps no store on any context, so the fiber walk cannot find
 * it — those apps still need the explicit handoff. Atom ENUMERATION off a found
 * store is handled separately by ./dev_discover.
 *
 * Read-only: never participates in the app's store-creation path. Injected into
 * the jotai adapter via DetectContext.jotaiGetStores so the adapter and detect.ts
 * stay DOM-free.
 */
import { collectContextValues } from '../../react/collect_context_values.js';
import { isJotaiStore, type JotaiStore } from './detect.js';

/**
 * Auto-discover live Jotai stores across the document's React roots. Walks every
 * Context provider value and keeps those matching the bare Jotai store surface.
 * De-duped by reference; [] when no React roots or no Jotai-shaped context value
 * is present.
 */
export const discoverJotaiStores = (doc: Document): JotaiStore[] => {
  const seen = new Set<JotaiStore>();
  const out: JotaiStore[] = [];
  for (const value of collectContextValues(doc)) {
    if (isJotaiStore(value) && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
};
