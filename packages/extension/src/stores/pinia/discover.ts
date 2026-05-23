/**
 * Page-world Pinia auto-discovery — finds live Pinia stores WITHOUT the explicit
 * window.__pwaDebug_pinia handoff (M37).
 *
 * How: Pinia's `app.use(pinia)` install sets `app.config.globalProperties.$pinia`
 * to the active Pinia instance (Vue 3), and that instance keeps every
 * instantiated store in its `_s` registry (a Map<storeId, store>). So we walk
 * the page's Vue mount roots — reusing the vue module's findVueRoots/getVueApp
 * rather than duplicating __vue_app__ walking — read `$pinia` off each app, and
 * collect the registered store instances.
 *
 * This is the sole DOM-touching part of Pinia detection; it is injected into the
 * pinia adapter via the framework-agnostic DetectContext.piniaGetStores seam so
 * the adapter and detect.ts stay pure (duck-typed reads only).
 */
import { findVueRoots } from '../../vue/find_vue_roots.js';
import { getVueApp } from '../../vue/get_vue_app.js';
import { isPiniaLike, type PiniaStore } from './detect.js';

/** Key Pinia attaches its active instance under on app.config.globalProperties. */
const PINIA_GLOBAL_KEY = '$pinia';

/** Pull Pinia-shaped store instances out of a Pinia instance's `_s` registry Map. */
const storesFromPiniaInstance = (pinia: unknown): PiniaStore[] => {
  const registry = (pinia as { _s?: unknown } | null | undefined)?._s;
  if (!(registry instanceof Map)) return [];
  const out: PiniaStore[] = [];
  for (const store of registry.values()) {
    if (isPiniaLike(store)) out.push(store);
  }
  return out;
};

/**
 * Auto-discover live Pinia stores across the document's Vue apps. Walks mount
 * roots in document order, reads each app's config.globalProperties.$pinia, and
 * collects its registered stores. Pinia instances are de-duped (one $pinia is
 * shared by all apps that called app.use(pinia)), so each registry is scanned
 * once. Returns [] when no Vue app exposes a Pinia instance.
 */
export const discoverPiniaStores = (doc: Document): PiniaStore[] => {
  const seenInstances = new Set<unknown>();
  const out: PiniaStore[] = [];
  for (const el of findVueRoots(doc)) {
    const pinia = getVueApp(el)?.config?.globalProperties?.[PINIA_GLOBAL_KEY];
    if (pinia == null || seenInstances.has(pinia)) continue;
    seenInstances.add(pinia);
    out.push(...storesFromPiniaInstance(pinia));
  }
  return out;
};
