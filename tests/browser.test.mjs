// ============================================================================
// REAL BROWSER TESTS. The unit tests in live-core.test.mjs run trip.js inside a
// Node vm with a STUBBED DOM and a fake Leaflet, so they prove the maths and
// never prove the app works. These load the actual pages in Chromium, with the
// real service worker, real Leaflet and real DOM, and assert what the user
// actually sees.
//
//   node --test tests/browser.test.mjs
//
// Leaflet is served from a local vendored copy so the suite does not depend on
// a CDN (which is blocked in CI sandboxes).
// ============================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = '/tmp/claude-0/-home-user-Travel/cc1ebd2e-2695-52d0-b7cf-48956770f86f/scratchpad';
const PW = SCRATCH + '/node_modules/playwright';
const LEAFLET_DIR = SCRATCH + '/node_modules/leaflet/dist';

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let server, browser, origin;

// A minimal Leaflet stand-in: real enough for trip.js to build the map and for
// us to count the polylines it draws, without reaching a CDN.
const LEAFLET_STUB = `
window.__polylines = [];
(function(){
  function layerObj(extra){
    const o = Object.assign({ _layers: [], addTo(p){ if(p&&p.addLayer)p.addLayer(this); return this; },
      addLayer(l){ this._layers.push(l); return this; }, clearLayers(){ this._layers.length=0; return this; },
      removeLayer(l){ const i=this._layers.indexOf(l); if(i>=0)this._layers.splice(i,1); return this; },
      bindPopup(){ return this; }, openPopup(){ return this; }, on(){ return this; }, off(){ return this; },
      setLatLng(){ return this; }, getBounds(){ return {}; }, eachLayer(){ return this; },
      setStyle(){ return this; }, redraw(){ return this; }, remove(){ return this; },
      bringToFront(){ return this; }, setZIndex(){ return this; }, hasLayer(){ return false; } }, extra||{});
    return o;
  }
  const L = {
    map(){ return layerObj({ setView(){return this;}, fitBounds(){return this;}, invalidateSize(){return this;},
      removeLayer(){return this;}, addLayer(){return this;}, getZoom(){return 8;}, setZoom(){return this;} }); },
    tileLayer(){ return layerObj(); },
    layerGroup(){ return layerObj(); },
    featureGroup(){ return layerObj(); },
    marker(){ return layerObj(); },
    divIcon(o){ return o; },
    icon(o){ return o; },
    polyline(pts, opts){ const p = layerObj({ _pts: pts, _opts: opts }); window.__polylines.push(p); return p; },
    latLngBounds(){ return { extend(){return this;}, isValid(){return true;} }; },
    control: { attribution(){ return layerObj(); } },
  };
  window.L = L;
})();
`;

function serve() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname).replace(/^\/Travel/, '') || '/';
      if (p === '/') p = '/index.html';
      // Serve the REAL Leaflet from node_modules. A stub only proved that
      // polyline() was CALLED; real Leaflet draws SVG <path> elements, so the
      // tests can assert a route is genuinely on the map.
      if (p.includes('leaflet')) {
        const ext = p.endsWith('.css') ? '.css' : '.js';
        const lf = path.join(LEAFLET_DIR, 'leaflet' + ext);
        if (fs.existsSync(lf)) {
          res.writeHead(200, { 'Content-Type': ext === '.css' ? 'text/css' : 'application/javascript' });
          return res.end(fs.readFileSync(lf));
        }
      }
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
      res.end(fs.readFileSync(file));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

// Open a trip page with a known itinerary injected, so tests do not depend on
// the shared cloud database (which the browser here cannot reach anyway).
async function openTrip(days, { tripId = 'london-scotland', day = 0 } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Block outbound calls the sandbox cannot make; let same-origin through.
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    if (u.includes('leaflet')) {
      const ext = u.endsWith('.css') ? '.css' : '.js';
      const lf = path.join(LEAFLET_DIR, 'leaflet' + ext);
      if (fs.existsSync(lf)) return route.fulfill({ status: 200,
        contentType: ext === '.css' ? 'text/css' : 'application/javascript', body: fs.readFileSync(lf) });
    }
    if (u.includes('unpkg.com') || u.includes('cdnjs')) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'void 0;' });
    }
    // Map tiles: a 1x1 PNG so Leaflet lays out normally without the network.
    if (u.includes('tile.openstreetmap.org')) return route.fulfill({ status: 200, contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    if (u.includes('firebaseio.com')) return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    return route.fulfill({ status: 204, body: '' });
  });
  await page.addInitScript(([id, d]) => {
    localStorage.setItem('tripState_' + id, JSON.stringify({ tripType: 'solo', title: 'Test', days: d }));
    localStorage.setItem('tripFamily_' + id, '0');
  }, [tripId, days]);
  await page.goto(`${origin}/Travel/trip.html?id=${tripId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state && Array.isArray(state.days), null, { timeout: 20000 });
  // The app opens on the OVERVIEW unless one of the days happens to be today, so
  // a test that inspects stop cards must select the day explicitly first.
  if (day !== null) {
    await page.evaluate((d) => switchDay(d), day);
    await page.waitForFunction(() => /stop-card/.test(document.getElementById('content-area').innerHTML)
      || (state.days[currentDayIdx] && (state.days[currentDayIdx].stops || []).length === 0), null, { timeout: 10000 });
  }
  return { page, errors };
}

before(async () => {
  origin = await serve();
  const { chromium } = require(PW);
  // The sandbox ships a specific Chromium build; the npm playwright version may
  // expect a different one. Point at the installed binary rather than downloading.
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  ];
  const executablePath = candidates.find((c) => fs.existsSync(c));
  browser = await chromium.launch(executablePath ? { executablePath } : {});
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

// ---------------------------------------------------------------------------
test('the app boots in a real browser with no page errors', async () => {
  const { page, errors } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'New Port Richey', type: 'hike', time: '3:00 PM', endTime: '3:30 PM', lat: 28.2442, lng: -82.7192 },
    ] },
  ]);
  const version = await page.textContent('#app-version');
  assert.match(version || '', /^v\d+$/, 'the header shows exactly ONE version, got: ' + version);
  assert.deepEqual(errors.filter((e) => !/favicon|Failed to load resource/i.test(e)), [],
    'no uncaught errors on boot');
  await page.close();
});

test('a flight card shows the correct time-zone-aware duration', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Flight ZO 784 — MCO to LGW', type: 'flight', time: '8:30 PM', endTime: '10:00 AM',
        startDate: '2026-08-04', endDate: '2026-08-05', tz: 'America/New_York', endTz: 'Europe/London',
        international: true, lat: 28.4312, lng: -81.3081, destLat: 51.1537, destLng: -0.1821,
        notes: 'Norse Atlantic UK flight ZO 784.' },
    ] },
  ]);
  const body = await page.textContent('#content-area');
  assert.ok(body.includes('8h 30min'), 'the real 8h 30min flight time is shown');
  assert.ok(!body.includes('25h 30min'), 'the lost-PM value must not appear');
  assert.ok(!body.includes('13h 30min'), 'the timezone-blind value must not appear');
  assert.ok(/Be at the airport by\s*5:30 PM/.test(body), 'airport chip is 3h before an 8:30 PM departure');
  await page.close();
});

// Count the route lines ACTUALLY on the map: Leaflet renders polylines as <path>
// elements in the overlay pane. Counting polyline() calls (the old stub approach)
// proved only that code ran, never that the user can see a route.
async function routePathCount(page) {
  return page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length);
}

test('the map really draws a route line for the drive to the airport', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'New Port Richey', type: 'hike', time: '3:00 PM', endTime: '3:30 PM', lat: 28.2442, lng: -82.7192 },
      { name: 'Flight ZO 784', type: 'flight', time: '8:30 PM', endTime: '10:00 AM', lat: 28.4312, lng: -81.3081 },
    ] },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('#map .leaflet-overlay-pane path').length > 0,
    null, { timeout: 15000 });
  assert.ok(await routePathCount(page) >= 1, 'a route line is rendered on the map');
  await page.close();
});

test('EVERY day of the real trip renders a route line on the map', async () => {
  const trip = JSON.parse(fs.readFileSync(path.join(ROOT, 'trips', 'london-scotland.json'), 'utf8'));
  const { page } = await openTrip(trip.days, { day: null });
  const blank = [];
  for (let i = 0; i < trip.days.length; i++) {
    const located = (trip.days[i].stops || []).filter((s) => s.lat && s.lng && !s.alt).length;
    await page.evaluate((idx) => switchDay(idx), i);
    if (located < 2) continue;   // a line needs two points
    let n = 0;
    for (let tries = 0; tries < 40 && n === 0; tries++) {
      n = await routePathCount(page);
      if (!n) await page.waitForTimeout(150);
    }
    if (!n) blank.push(i + 1);
  }
  assert.deepEqual(blank, [], 'these days show NO route line on the map: ' + blank.join(', '));
  await page.close();
});

test('End Time and Duration stay in sync in the real Edit Stop form', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '12:03 PM', endTime: '4:12 PM', duration: '2hrs',
        lat: 51.5194, lng: -0.127 },
    ] },
  ]);
  await page.evaluate(() => openEditStopModal(0, 0));
  await page.waitForSelector('#f-duration', { state: 'attached' });
  // Opening the form must already show the TRUE span, not the stale "2hrs".
  const shown = await page.inputValue('#f-duration');
  assert.equal(shown, '4h 9min', 'duration derived from the times on open, got ' + shown);
  // Typing a new End Time updates Duration.
  await page.fill('#f-endtime', '14:03');
  await page.dispatchEvent('#f-endtime', 'input');
  await page.waitForFunction(() => document.getElementById('f-duration').value === '2hrs', null, { timeout: 4000 });
  // Typing a Duration updates End Time.
  await page.fill('#f-duration', '3h');
  await page.dispatchEvent('#f-duration', 'input');
  await page.waitForFunction(() => document.getElementById('f-endtime').value === '15:03', null, { timeout: 4000 });
  await page.close();
});

test('a stop card never shows a duration that contradicts its own times', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '12:03 PM', endTime: '4:12 PM', duration: '2hrs',
        lat: 51.5194, lng: -0.127 },
    ] },
  ]);
  const body = await page.textContent('#content-area');
  assert.ok(body.includes('4h 9min'), 'the true span is shown');
  assert.ok(!body.includes('2hrs'), 'the stale stored duration must not be rendered');
  await page.close();
});

// CASE STUDY: "put the ticket button on the hotel box" means EVERY hotel box.
// It was first implemented on the day bookend only, leaving the Overview's
// lodging cards without it. This test walks every surface that renders a hotel,
// so a future change to one cannot silently skip the others.
test('EVERY hotel surface shows the reservation and its ticket', async () => {
  const hotel = { name: 'Royal Horseguards Hotel', type: 'lodge', time: '9:00 PM', endTime: '9:30 PM',
    reservation: '1072991266', ticketImage: 'data:image/png;base64,iVBORw0KGgo=', lat: 51.5063, lng: -0.1237 };
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [hotel] },
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '11:00 AM', endTime: '1:00 PM', lat: 51.5194, lng: -0.127 },
      Object.assign({}, hotel, { name: 'Royal Horseguards Hotel' }),
    ] },
  ], { day: null });

  const surfaces = [];
  // 1. The OVERVIEW lodging cards.
  await page.evaluate(() => switchDay(-1));
  await page.waitForFunction(() => /lodge-card/.test(document.getElementById('content-area').innerHTML), null, { timeout: 8000 });
  surfaces.push(['overview lodging card', await page.innerHTML('#content-area')]);
  // 2. The end-of-day "Tonight" bookend.
  await page.evaluate(() => switchDay(1));
  await page.waitForFunction(() => /hotel-bookend/.test(document.getElementById('content-area').innerHTML), null, { timeout: 8000 });
  surfaces.push(['day hotel bookend', await page.innerHTML('#content-area')]);
  // 3. The hotel's own stop card.
  await page.evaluate(() => switchDay(0));
  await page.waitForFunction(() => /stop-card/.test(document.getElementById('content-area').innerHTML), null, { timeout: 8000 });
  surfaces.push(['hotel stop card', await page.innerHTML('#content-area')]);

  for (const [what, html] of surfaces) {
    assert.ok(/1072991266/.test(html), what + ' must show the confirmation number');
    assert.ok(/showTicketViewer\(/.test(html), what + ' must offer a button that opens the reservation');
  }
  await page.close();
});

test('the day hotel bookend exposes the reservation and its ticket', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Royal Horseguards Hotel', type: 'lodge', time: '9:00 PM', endTime: '9:30 PM',
        reservation: '1072991266', ticketImage: 'data:image/png;base64,iVBORw0KGgo=',
        lat: 51.5063, lng: -0.1237 },
    ] },
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '11:00 AM', endTime: '1:00 PM', lat: 51.5194, lng: -0.127 },
    ] },
  ], { day: 1 });
  const html = await page.innerHTML('#content-area');
  assert.ok(/hotel-bookend/.test(html), 'the hotel bookend is rendered');
  assert.ok(/1072991266/.test(html), 'the confirmation number is shown on the hotel box');
  assert.ok(/View Reservation/.test(html), 'the reservation/ticket button is present');
  await page.close();
});

test('a stop scheduled before the landing time is moved automatically', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Flight ZO 784', type: 'flight', time: '8:30 PM', endTime: '10:00 AM', lat: 28.4312, lng: -81.3081 },
    ] },
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Royal Horseguards Hotel', type: 'lodge', time: '9:00 AM', endTime: '9:30 AM', lat: 51.5063, lng: -0.1237 },
      { name: 'British Museum', type: 'hike', time: '11:00 AM', endTime: '1:00 PM', lat: 51.5194, lng: -0.127 },
    ] },
  ]);
  const after = await page.evaluate(() => {
    _seedLogicBaseline();
    saveState('touch');
    return state.days[1].stops.map((s) => ({ name: s.name, time: s.time }));
  });
  const hotel = after.find((s) => /Horseguards/.test(s.name));
  assert.ok(/10:00 AM|1[0-9]:\d\d AM|PM/.test(hotel.time),
    'the hotel moved to at/after the 10:00 AM landing, got ' + hotel.time);
  await page.close();
});
