// =============================================================================
// DEPLOYMENT INSTRUCTIONS
// =============================================================================
// The local `git push` in this environment goes to a proxy that does NOT
// forward to real GitHub. Changes will NOT appear on the live site via git.
//
// To deploy to https://sps047-code.github.io/Travel/ you must use MCP tools:
//
//   1. Use mcp__github__push_files  (for multiple files at once)
//      or mcp__github__create_or_update_file  (for a single file)
//      Target branch: gh-pages
//      Repo: sps047-code/Travel
//
//   2. Bump the CACHE version below (e.g. seasons-v9 → seasons-v10)
//      so the service worker forces all devices to reload fresh assets.
//
//   3. If adding a new file, add its path to the PRECACHE array below
//      AND include it in the MCP push call.
//
//   4. Files >~50KB must be split before pushing (MCP has a token limit).
//      e.g. trip.html (HTML+CSS) + trip.js (JavaScript) — already done.
// =============================================================================

const CACHE = 'seasons-v69';
const PRECACHE = [
  '/Travel/index.html',
  '/Travel/trip.html',
  '/Travel/trip.js',
  '/Travel/trip-extras.js',
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
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
    .then(() => self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs =>
      Promise.all(cs.map(c => c.navigate(c.url).catch(()=>{})))
    ))
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // Hard reload (Cache-Control: no-cache) — bypass SW cache, fetch fresh from network
  const cc = e.request.headers.get('cache-control');
  if (cc && cc.includes('no-cache')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Stale-while-revalidate for OSM map tiles
  if (url.includes('tile.openstreetmap.org')) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const network = fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || network;
        })
      )
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
  const url = e.notification.data?.url || '/Travel/';
  e.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
      for (const c of list) {
        if (c.url.includes('/Travel/') && 'focus' in c) { c.focus(); return; }
      }
      return clients.openWindow('/Travel/' + url);
    })
  );
});
