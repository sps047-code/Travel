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

const CACHE = 'seasons-v14';
const PRECACHE = [
  '/Travel/index.html',
  '/Travel/trip.html',
  '/Travel/trip.js',
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
