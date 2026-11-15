/* Qubit AI — офлайн-кеш оболочки.
   Стратегия: network-first для навигации, cache-first для статики.
   При обновлении версии кеш сбрасывается. */

const VERSION = 'qubit-v16';
const ASSETS = [
  './agent.js',
  './api.js',
  './app.css',
  './app.js',
  './base.css',
  './chat.js',
  './config.js',
  './files.js',
  './icons.js',
  './index.html',
  './invite-ui.js',
  './invite.js',
  './manifest.webmanifest',
  './markdown.css',
  './markdown.js',
  './modals.js',
  './preview.js',
  './pricing.js',
  './providers.js',
  './settings.js',
  './shell.js',
  './state.js',
  './storage.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // API и сторонние запросы не трогаем

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    }),
  );
});
