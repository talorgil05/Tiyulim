// Service worker: lets the app be installed to the home screen and opens fast.
// Network first (a new deploy reaches every phone at once); the cache is only a fallback when offline.
// API data is never cached — the shared database is always the source of truth.
const CACHE = 'tiyulim-v5';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/js/app.js', '/js/api.js', '/js/util.js', '/js/views.js', '/js/install.js',
  '/js/onboarding.js', '/js/theme-boot.js', '/icons/logo.png', '/icons/favicon-64.png', '/icons/icon-192.png', '/css/splash.css', '/js/splash-boot.js', '/js/pdf.js', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});
