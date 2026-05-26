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

// Jotai handoff (Path 4 M5). The createStore() instance backing the JotaiProvider
// below is auto-DISCOVERED off the React fiber context (M44), but jotai >=2.12
// removed the store.dev*_get_mounted_atoms API, so atoms can no longer be
// ENUMERATED from a bare store — the wrapped { store, atoms } handoff remains
// required to expose the name->atom registry the adapter snapshots. See the M44
// analysis note. (On jotai 2.0–2.11 enumeration auto-works; this fixture pins
// 2.20.)
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
