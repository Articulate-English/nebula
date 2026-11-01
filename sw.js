// Nebula service worker.
//
// Bump CACHE_VERSION whenever the app shell changes. The old version's cache is
// deleted on activate, so a stale index.html can never be served forever.
const CACHE_VERSION = 'v8';
const CACHE_NAME = `nebula-${CACHE_VERSION}`;

// Static assets that are safe to cache first (they are content-hashed by name
// only, so keep this list to files that rarely change).
const STATIC_ASSETS = [
  './galaxy.jpg',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

const APP_SHELL = ['./', './index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Never intercept the service worker itself.
  if (request.url.endsWith('/sw.js') || request.url.endsWith('sw.js')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isAppShell = APP_SHELL.some(p => {
    const target = new URL(p, self.location.origin + self.location.pathname).href;
    return request.url === target || request.url.replace(/\/$/, '') === target.replace(/\/$/, '');
  });

  if (isAppShell) {
    // Network-first: the app shell must always reflect the deployed version.
    // Fall back to the cache when offline.
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() =>
        caches.match(request).then(cached => cached || caches.match('./index.html'))
      )
    );
    return;
  }

  // Cache-first for everything else (images, manifests, icons).
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response && response.ok && (request.url.startsWith('http:') || request.url.startsWith('https:'))) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
