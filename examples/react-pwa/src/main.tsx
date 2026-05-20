import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { App } from './App.js';
import { store } from './store.js';

// Fixture-internal opt-in handoff for pwa-debug's M11 T1 detection path. The
// production __REDUX_DEVTOOLS_EXTENSION__ shim (M11 T2) auto-detects without
// this assignment, but the explicit handoff stays for manual smoke testing.
(window as unknown as { __pwaDebug_redux?: unknown }).__pwaDebug_redux = store;

const container = document.getElementById('root');
if (container === null) throw new Error('root container not found');

const root = createRoot(container);
root.render(
  <Provider store={store}>
    <App />
  </Provider>,
);
