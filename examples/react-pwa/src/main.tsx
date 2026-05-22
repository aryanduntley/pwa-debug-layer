import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { Provider as JotaiProvider } from 'jotai';
import { App } from './App.js';
import { store } from './store.js';
import { useZustandStore } from './zustandStore.js';
import { jotaiStore, jotaiAtoms } from './jotaiStore.js';

// Fixture-internal opt-in handoff for pwa-debug's M11 T1 detection path. The
// production __REDUX_DEVTOOLS_EXTENSION__ shim (M11 T2) auto-detects without
// this assignment, but the explicit handoff stays for manual smoke testing.
(window as unknown as { __pwaDebug_redux?: unknown }).__pwaDebug_redux = store;

// Zustand handoff for pwa-debug's Path 4 M3 detection path. The create() hook
// also exposes getState/setState/subscribe, so it doubles as the vanilla store
// the Zustand adapter duck-types. (No Zustand devtools auto-capture shim yet —
// that path is deferred, so the explicit handoff is the way to detect it.)
(window as unknown as { __pwaDebug_zustand?: unknown }).__pwaDebug_zustand =
  useZustandStore;

// Jotai handoff (Path 4 M5). Jotai has no addressable tree, so the adapter
// expects the wrapped { store, atoms } shape: the createStore() instance plus a
// name->atom registry. The same store backs the JotaiProvider below.
(window as unknown as { __pwaDebug_jotai?: unknown }).__pwaDebug_jotai = {
  store: jotaiStore,
  atoms: jotaiAtoms,
};

const container = document.getElementById('root');
if (container === null) throw new Error('root container not found');

const root = createRoot(container);
root.render(
  <Provider store={store}>
    <JotaiProvider store={jotaiStore}>
      <App />
    </JotaiProvider>
  </Provider>,
);
