const CACHE = 'seasons-v4';
const PRECACHE = [
  '/Travel/index.html',
  '/Travel/trip.html',
  '/Travel/app.webmanifest',
  '/Travel/icon-192.png',
  '/Travel/icon-512.png',
  '/Travel/leaf-logo.png',
  '/Travel/trips/manifest.json',
  '/Travel/trips/utah.json',
  '/Travel/trips/ny-fall.json',
  '/Travel/trips/london-scotland.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
