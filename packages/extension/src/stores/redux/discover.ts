/**
 * Page-world Redux auto-discovery — finds live react-redux stores WITHOUT the
 * explicit window.__pwaDebug_redux handoff, by reading them PASSIVELY from the
 * React fiber tree (M46).
 *
 * How: react-redux's `<Provider store={store}>` puts the store on
 * ReactReduxContext; the context value is `{ store, subscription, … }`. We
 * collect every React context value (react/collect_context_values) and duck-type
 * for a Redux store — either `value.store` (react-redux's shape) or `value`
 * itself (defensive, for setups that put a store-shaped object on a context).
 *
 * Read-only: this NEVER participates in the app's store-creation path (unlike
 * the removed __REDUX_DEVTOOLS_EXTENSION__ shim), so it cannot break the host
 * app. Injected into the redux adapter via DetectContext.reduxGetStores so
 * detect.ts stays DOM-free.
 */
import { collectContextValues } from '../../react/collect_context_values.js';
import { isReduxLike, type ReduxStoreHandle } from './detect.js';

const reduxStoreFromContextValue = (
  value: object,
): ReduxStoreHandle | null => {
  const store = (value as { store?: unknown }).store;
  if (isReduxLike(store)) return store;
  if (isReduxLike(value)) return value;
  return null;
};

/**
 * Auto-discover live react-redux stores across the document's React roots.
 * Walks every Context provider value and extracts the redux store from the
 * react-redux context shape. De-duped by reference; [] when none found.
 */
export const discoverReduxStores = (doc: Document): ReduxStoreHandle[] => {
  const seen = new Set<ReduxStoreHandle>();
  const out: ReduxStoreHandle[] = [];
  for (const value of collectContextValues(doc)) {
    const store = reduxStoreFromContextValue(value);
    if (store !== null && !seen.has(store)) {
      seen.add(store);
      out.push(store);
    }
  }
  return out;
};
