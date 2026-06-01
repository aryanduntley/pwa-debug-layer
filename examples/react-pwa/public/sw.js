/*
 * Service worker for the pwa-debug React fixture.
 *
 * Exists so pwa-debug-layer's PWA Runtime Diagnostics tools have something real
 * to read:
 *   - sw_status / sw_lifecycle_tail  -> a registration + controller + lifecycle
 *   - cache_list / cache_inspect / cache_match -> a populated CacheStorage
 *   - pwa_status -> controlledBySW + a real controller scriptURL
 *
 * To demonstrate a WAITING update (sw_status.hasWaitingUpdate /
 * sw_lifecycle_tail), bump CACHE_VERSION and reload with a tab still open:
 * skipWaiting() is intentionally NOT called, so the new worker waits.
 */

const CACHE_VERSION = 'pdl-fixture-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          // Runtime-cache same-origin GETs so cache_inspect has fresh entries.
          if (res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
