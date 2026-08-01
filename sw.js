// =============================================================================
// DEPLOYMENT INSTRUCTIONS
// =============================================================================
// To deploy to https://sps047-code.github.io/Travel/ :
//
//   1. Commit your changes and run:  git push origin gh-pages
//      The local git proxy DOES forward to the real GitHub gh-pages branch
//      (verified). Prefer this over MCP for BINARY files (icons) — MCP
//      requires hand-transcribing base64, which corrupts large files.
//
//   2. Bump the CACHE version below (e.g. seasons-v9 → seasons-v10)
//      so the service worker forces all devices to reload fresh assets.
//
//   3. If adding a new file, add its path to the PRECACHE array below.
//
//   4. Verify a deploy landed by reading the file back with
//      mcp__github__get_file_contents (ref: refs/heads/gh-pages).
// =============================================================================

const CACHE = 'seasons-v188';
const PRECACHE = [
  '/Travel/index.html',
  '/Travel/trip.html',
  '/Travel/trip.js',
  '/Travel/trip.js?v=188',
  '/Travel/trip-extras.js',
  '/Travel/trip-extras.js?v=188',
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
  // Cache each file individually so a single failure doesn't block installation
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(PRECACHE.map(url =>
        fetch(url, {cache: 'no-store'}).then(res => { if (res.ok) cache.put(url, res); })
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Keep the current app-shell cache, the saved audio-tour cache, AND the
    // offline-download cache (so downloaded itineraries survive app updates).
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== 'seasons-audio' && k !== 'seasons-offline').map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
    // NOTE: do not force-navigate clients here. That plus the pages' own
    // controllerchange reload produced TWO reloads per update. The guarded
    // controllerchange handler is the single update mechanism.
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // Page navigations (e.g. trip.html?id=london-scotland&fam=1): network-first so
  // you get fresh HTML online, but fall back to the cached page when offline. The
  // query string is ignored so any trip URL resolves to the cached page shell.
  if (e.request.mode === 'navigate') {
    // TRULY network-first. This previously did `return cached || network`, which is
    // cache-FIRST: the stale page was served every time and the fresh copy only
    // landed in the cache for the NEXT load. Every HTML change therefore needed two
    // reloads to appear, so new inline handlers and fields looked like they had
    // never shipped. Online = always the current page; offline = the cached one.
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{}); }
        return res;
      }).catch(() =>
        caches.match(e.request, {ignoreSearch:true})
          .then(c => c || caches.match('/Travel/trip.html', {ignoreSearch:true}))
          .then(c => c || caches.match('/Travel/index.html'))
      )
    );
    return;
  }
  // Hard reload (Cache-Control: no-cache) — bypass SW cache, fetch fresh from network
  const cc = e.request.headers.get('cache-control');
  if (cc && cc.includes('no-cache')) {
    e.respondWith(
      fetch(e.request).then(res => {
        // Clone SYNCHRONOUSLY: .clone() inside the async .then ran after the body
        // had been handed to the page, so the put silently failed.
        if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{}); }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Stale-while-revalidate for OSM map tiles. Check ALL caches (incl. the
  // offline-download cache) so downloaded tiles are served when offline.
  if (url.includes('tile.openstreetmap.org')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{}); }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }
  // Cache-first for app shell
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

self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Default to '' — '/Travel/' here produced '/Travel//Travel/' below.
  const url = e.notification.data?.url || '';
  e.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
      for (const c of list) {
        if (c.url.includes('/Travel/') && 'focus' in c) { c.focus(); return; }
      }
      return clients.openWindow('/Travel/' + url);
    })
  );
});
