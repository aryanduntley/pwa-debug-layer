import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { useCounterStore } from './counterStore';

const pinia = createPinia();
const app = createApp(App);
app.use(pinia);

// Explicit handoff for pwa-debug's Pinia adapter (Path 4): a single store
// instance exposing $state/$patch/$subscribe. Auto-discovery (getActivePinia /
// __VUE_DEVTOOLS_GLOBAL_HOOK__) is a Path 5 follow-on; this explicit handoff is
// how the adapter detects the store today, mirroring the React fixture's
// __pwaDebug_redux/__pwaDebug_zustand/__pwaDebug_jotai handoffs.
(window as unknown as { __pwaDebug_pinia?: unknown }).__pwaDebug_pinia =
  useCounterStore(pinia);

app.mount('#app');
