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
async function openTrip(days, { tripId = 'london-scotland', day = 0, family = false } = {}) {
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
  await page.addInitScript(([id, d, fam]) => {
    localStorage.setItem('tripState_' + id, JSON.stringify({ tripType: fam ? 'family' : 'solo', title: 'Test', days: d }));
    localStorage.setItem('tripFamily_' + id, fam ? '1' : '0');
  }, [tripId, days, family]);
  await page.goto(`${origin}/Travel/trip.html?id=${tripId}` + (family ? '&fam=1' : ''), { waitUntil: 'domcontentloaded' });
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

test('a SHARED (family) trip still renders routes while the sync poll runs', async () => {
  const trip = JSON.parse(fs.readFileSync(path.join(ROOT, 'trips', 'london-scotland.json'), 'utf8'));
  const { page } = await openTrip(trip.days, { day: null, family: true });
  const blank = [];
  for (const d of [2, 3, 9, 10, 11]) {
    await page.evaluate((i) => switchDay(i), d - 1);
    let n = 0;
    for (let t = 0; t < 40 && n === 0; t++) {
      n = await routePathCount(page);
      if (!n) await page.waitForTimeout(150);
    }
    if (!n) blank.push(d);
  }
  assert.deepEqual(blank, [], 'shared trip days with NO route: ' + blank.join(', '));
  await page.close();
});

test('the map never gets stuck on "Loading driving routes"', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'A', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 55.9486, lng: -3.1999 },
      { name: 'B', type: 'hike', time: '11:00 AM', endTime: '12:00 PM', lat: 55.9526, lng: -3.1722 },
    ] },
  ]);
  // Force overlapping renders, which is what the 3s family poll does.
  await page.evaluate(() => { renderDayMap(0); renderDayMap(0); renderDayMap(0); });
  await page.waitForFunction(() => {
    const st = document.getElementById('route-status');
    return !st || st.style.display === 'none' || !/Loading/.test(st.textContent || '');
  }, null, { timeout: 12000 });
  await page.close();
});

test('a day that truly cannot draw a route SAYS so instead of going blank', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'No pin', type: 'hike', time: '9:00 AM', endTime: '10:00 AM' },
    ] },
  ]);
  await page.waitForFunction(() => {
    const st = document.getElementById('route-status');
    return st && st.style.display !== 'none' && /No route/.test(st.textContent || '');
  }, null, { timeout: 12000 });
  const msg = await page.textContent('#route-status');
  assert.match(msg, /No route: 0 located stops of 1/, 'the map explains itself: ' + msg);
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

// ===========================================================================
// THE HOME PAGE (index.html). It had NO browser coverage, which is how a
// broken home page shipped in v176/v177: index.html used var(--space-*)
// without defining those tokens, so every padding resolved to nothing and the
// trip cards collapsed. These assert on COMPUTED styles, so an undefined token
// fails loudly instead of silently rendering a squashed layout.
// ===========================================================================
async function openHome() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    if (u.includes('firebaseio.com')) return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto(`${origin}/Travel/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#trips-grid', { timeout: 15000 });
  await page.waitForTimeout(700);
  return { page, errors };
}

test('the home page loads with no errors and shows the trip cards', async () => {
  const { page, errors } = await openHome();
  const cards = await page.locator('.trip-card').count();
  assert.ok(cards >= 1, 'at least one trip card is rendered, got ' + cards);
  assert.deepEqual(errors.filter((e) => !/favicon|Failed to load resource/i.test(e)), []);
  await page.close();
});

test('EVERY CSS custom property the pages use is actually defined', async () => {
  // The exact failure from v176/v177: a token was referenced but never declared,
  // so it silently resolved to nothing.
  for (const url of ['/Travel/index.html', '/Travel/trip.html?id=london-scotland']) {
    const page = await browser.newPage();
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(origin)) return route.continue();
      if (u.includes('leaflet')) {
        const ext = u.endsWith('.css') ? '.css' : '.js';
        const lf = path.join(LEAFLET_DIR, 'leaflet' + ext);
        if (fs.existsSync(lf)) return route.fulfill({ status: 200,
          contentType: ext === '.css' ? 'text/css' : 'application/javascript', body: fs.readFileSync(lf) });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto(origin + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const undefinedTokens = await page.evaluate(() => {
      const used = new Set();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const r of Array.from(rules || [])) {
          const t = r.cssText || '';
          for (const m of t.matchAll(/var\((--[a-z0-9-]+)\)/gi)) used.add(m[1]);
        }
      }
      const root = getComputedStyle(document.documentElement);
      return [...used].filter((t) => !root.getPropertyValue(t).trim());
    });
    assert.deepEqual(undefinedTokens, [], url + ' references undefined tokens: ' + undefinedTokens.join(', '));
    await page.close();
  }
});

test('home page trip cards have real padding (not collapsed by a missing token)', async () => {
  const { page } = await openHome();
  const box = await page.evaluate(() => {
    const body = document.querySelector('.trip-card .trip-card-body');
    if (!body) return null;
    const cs = getComputedStyle(body);
    return { top: parseFloat(cs.paddingTop), left: parseFloat(cs.paddingLeft) };
  });
  assert.ok(box, 'a trip card body exists');
  assert.ok(box.top >= 8 && box.left >= 8,
    'card padding must not collapse — got top ' + box.top + 'px, left ' + box.left + 'px');
  await page.close();
});

test('home page destination pills are visually separated', async () => {
  const { page } = await openHome();
  const gap = await page.evaluate(() => {
    const pills = document.querySelectorAll('.trip-card .trip-meta-pill');
    if (pills.length < 2) return null;
    const cs = getComputedStyle(pills[0]);
    return { padX: parseFloat(cs.paddingLeft), w: pills[0].getBoundingClientRect().width };
  });
  if (gap) {
    assert.ok(gap.padX >= 4, 'pills need horizontal padding, got ' + gap.padX + 'px');
    assert.ok(gap.w > 20, 'pills must have real width, got ' + gap.w + 'px');
  }
  await page.close();
});

// ===========================================================================
// DATA INTEGRITY through real UI actions. Every bug in this app that actually
// cost the user work was a silent data change, not a visual glitch. These drive
// the real functions and assert nothing is lost.
// ===========================================================================
function richStop(over) {
  return Object.assign({
    name: 'British Museum', type: 'hike', time: '12:00 PM', endTime: '2:00 PM',
    lat: 51.5194, lng: -0.127, _sid: 'sid-keep', guidebook: 'GUIDEBOOK TEXT',
    dayHours: '10:00 AM - 5:00 PM', dayHoursSrc: 'osm', destLat: 51.5, destLng: -0.12,
    reservation: 'ABC123', notes: 'Rosetta Stone.', url: 'https://example.com',
  }, over || {});
}

test('journal notes and ratings survive an edit of the same stop', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [richStop()] },
  ]);
  const kept = await page.evaluate(() => {
    // Write a journal note + rating the way the UI does.
    saveJnlStopNote(0, 0, 'Loved the Egyptian rooms');
    saveJnlStopRating(0, 0, 5);
    const noteKey = _jnlNoteKey(0, 0), ratingKey = _jnlRatingKey(0, 0);
    // Now edit the stop through the real save path.
    const s = state.days[0].stops[0];
    s.notes = 'edited notes';
    saveState('edit');
    return { note: jnlData[noteKey], rating: jnlData[ratingKey], sid: state.days[0].stops[0]._sid };
  });
  assert.equal(kept.note, 'Loved the Egyptian rooms', 'the journal note survives');
  assert.equal(kept.rating, 5, 'the rating survives');
  assert.equal(kept.sid, 'sid-keep', 'the stable id it is keyed by survives');
  await page.close();
});

test('moving a stop keeps every hidden field intact', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Castle', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 55.9486, lng: -3.1999 },
      richStop(),
    ] },
  ]);
  const after = await page.evaluate(() => {
    moveStop(0, 1, -1);
    const s = state.days[0].stops.find((x) => x.name === 'British Museum');
    return { sid: s._sid, guidebook: s.guidebook, dayHours: s.dayHours,
      dayHoursSrc: s.dayHoursSrc, destLat: s.destLat, reservation: s.reservation, url: s.url };
  });
  assert.equal(after.sid, 'sid-keep');
  assert.equal(after.guidebook, 'GUIDEBOOK TEXT');
  assert.equal(after.dayHours, '10:00 AM - 5:00 PM');
  assert.equal(after.dayHoursSrc, 'osm');
  assert.equal(after.destLat, 51.5);
  assert.equal(after.reservation, 'ABC123');
  assert.equal(after.url, 'https://example.com');
  await page.close();
});

test('deleting a stop removes exactly one and leaves the rest untouched', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'A', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 55.94, lng: -3.19 },
      { name: 'B', type: 'hike', time: '11:00 AM', endTime: '12:00 PM', lat: 55.95, lng: -3.18 },
      { name: 'C', type: 'hike', time: '1:00 PM', endTime: '2:00 PM', lat: 55.96, lng: -3.17 },
    ] },
  ]);
  const after = await page.evaluate(() => {
    window.confirm = () => true;              // the delete prompt
    deleteStop(0, 1);
    return state.days[0].stops.map((s) => ({ n: s.name, t: s.time }));
  });
  assert.equal(after.length, 2, 'exactly one stop removed');
  assert.deepEqual(JSON.stringify(after.map((x) => x.n)), JSON.stringify(['A', 'C']));
  assert.equal(after[0].t, '9:00 AM', 'a surviving stop keeps its time');
  assert.equal(after[1].t, '1:00 PM', 'the other survivor keeps its time too');
  await page.close();
});

test('the checklist and packing list persist a toggle', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [richStop()] },
  ]);
  const res = await page.evaluate(() => {
    state.checklist = state.checklist || [];
    state.checklist.push({ id: 'test-item', text: 'Book museum tickets', done: false });
    toggleCheckItem('test-item', true);
    const item = state.checklist.find((c) => c.id === 'test-item');
    const saved = JSON.parse(localStorage.getItem('tripState_london-scotland') || '{}');
    const savedItem = (saved.checklist || []).find((c) => c.id === 'test-item');
    return { done: item && item.done, persisted: savedItem && savedItem.done };
  });
  assert.equal(res.done, true, 'the checklist item is ticked in state');
  assert.equal(res.persisted, true, 'and written to storage, not just the DOM');
  await page.close();
});

test('a day with no stops renders without throwing', async () => {
  const { page, errors } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [] },
  ]);
  const html = await page.innerHTML('#content-area');
  assert.ok(html.length > 0, 'something renders for an empty day');
  assert.deepEqual(errors.filter((e) => !/favicon|Failed to load resource/i.test(e)), []);
  await page.close();
});

// ===========================================================================
// THE IMPORT FLOW. It writes a whole itinerary in one shot, and the "append"
// mode merges into an EXISTING trip — the highest-risk write in the app. The AI
// call is stubbed so these test the parsing, saving and merging, not the model.
// ===========================================================================
async function openHomeForImport(aiResponse, { localTrips = null, tripStates = null } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Record navigations but LET THEM HAPPEN. window.location cannot be redefined
  // in modern Chrome, and aborting the navigation leaves the document in a state
  // where localStorage access is denied. Letting the redirect run is also closer
  // to what really happens, and same-origin storage survives it.
  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.addInitScript(([lt, ts]) => {
    if (lt) localStorage.setItem('localTrips', JSON.stringify(lt));
    if (ts) for (const [k, v] of Object.entries(ts)) localStorage.setItem('tripState_' + k, JSON.stringify(v));
  }, [localTrips, tripStates]);
  await page.goto(`${origin}/Travel/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof importTrip === 'function', null, { timeout: 15000 });
  // Stub the model call; everything downstream is the app's own code.
  await page.evaluate((resp) => { window.callClaude = async () => resp; }, aiResponse);
  return { page, errors, navs };
}

const IMPORTED = JSON.stringify({
  title: 'Paris Weekend',
  days: [
    { title: 'Day 1 — Arrive', subtitle: 'Fri, Sep 4, 2026', stops: [
      { name: 'Eurostar to Paris', type: 'train', time: '9:00 AM', endTime: '11:30 AM' },
      { name: 'Hotel Lutetia', type: 'lodge', time: '1:00 PM', reservation: 'LUT-9931' },
    ] },
    { title: 'Day 2 — Museums', subtitle: 'Sat, Sep 5, 2026', stops: [
      { name: 'Louvre', type: 'hike', time: '9:30 AM', endTime: '12:30 PM' },
    ] },
  ],
});

test('import creates a new trip with every stop preserved', async () => {
  const { page, navs } = await openHomeForImport(IMPORTED);
  await page.evaluate(async () => {
    document.getElementById('import-text').value = 'Eurostar 9am, Hotel Lutetia, Louvre Saturday';
    _importMode = 'new';
    await importTrip();
  });
  await page.waitForURL(/trip\.html/, { timeout: 15000 });
  const nav = page.url();
  const res = await page.evaluate((nav) => {
    const id = (nav.match(/id=([^&]+)/) || [])[1];
    const saved = id ? JSON.parse(localStorage.getItem('tripState_' + id) || 'null') : null;
    const listed = JSON.parse(localStorage.getItem('localTrips') || '[]').find((t) => t.id === id);
    return { nav, id, days: saved && saved.days.length,
      stops: saved && saved.days.reduce((n, d) => n + d.stops.length, 0),
      title: saved && saved.title, resv: saved && saved.days[0].stops[1].reservation, listed: !!listed };
  }, nav);
  assert.ok(res.id && res.id.startsWith('import-'), 'a new trip id was created: ' + res.nav);
  assert.equal(res.days, 2, 'both days imported');
  assert.equal(res.stops, 3, 'all three stops imported');
  assert.equal(res.title, 'Paris Weekend');
  assert.equal(res.resv, 'LUT-9931', 'reservation numbers survive the import');
  assert.ok(res.listed, 'the trip appears in the trips list');
  await page.close();
});

test('import survives an AI reply wrapped in markdown fences', async () => {
  const { page, navs } = await openHomeForImport('```json\n' + IMPORTED + '\n```');
  await page.evaluate(async () => {
    document.getElementById('import-text').value = 'anything';
    _importMode = 'new';
    await importTrip();
  });
  await page.waitForURL(/trip\.html/, { timeout: 15000 });
  const ok = await page.evaluate((nav) => {
    const id = ((nav || '').match(/id=([^&]+)/) || [])[1];
    const saved = id ? JSON.parse(localStorage.getItem('tripState_' + id) || 'null') : null;
    return saved && saved.days.length;
  }, page.url());
  assert.equal(ok, 2, 'fenced JSON is still parsed into a trip');
  await page.close();
});

test('import REFUSES an empty result instead of creating a broken trip', async () => {
  const { page, navs } = await openHomeForImport(JSON.stringify({ title: 'Nothing', days: [] }));
  const res = await page.evaluate(async () => {
    const before = JSON.parse(localStorage.getItem('localTrips') || '[]').length;
    document.getElementById('import-text').value = 'some text';
    _importMode = 'new';
    await importTrip();
    const err = document.getElementById('import-error');
    return { after: JSON.parse(localStorage.getItem('localTrips') || '[]').length, before,
      shown: err && err.classList.contains('visible'), msg: err && err.textContent };
  });
  await page.waitForTimeout(400);
  assert.ok(!/trip\.html/.test(page.url()), 'no navigation to a broken trip, still at ' + page.url());
  assert.equal(res.after, res.before, 'no trip was created');
  assert.ok(res.shown, 'the user is told why');
  assert.match(res.msg || '', /No stops found/i);
  await page.close();
});

test('import with no text asks for text and creates nothing', async () => {
  const { page, navs } = await openHomeForImport(IMPORTED);
  const res = await page.evaluate(async () => {
    const before = JSON.parse(localStorage.getItem('localTrips') || '[]').length;
    document.getElementById('import-text').value = '   ';
    _importMode = 'new';
    await importTrip();
    return { after: JSON.parse(localStorage.getItem('localTrips') || '[]').length, before };
  });
  await page.waitForTimeout(400);
  assert.equal(res.after, res.before);
  assert.ok(!/trip\.html/.test(page.url()), 'nothing was created and we stayed put');
  await page.close();
});

test('APPEND import queues the new days without touching the existing trip', async () => {
  const existing = { tripType: 'solo', title: 'My Trip', days: [
    { title: 'Day 1', subtitle: 'Fri, Sep 4, 2026', stops: [
      { name: 'Existing stop', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', _sid: 'keep-me' },
    ] },
  ] };
  const { page, navs } = await openHomeForImport(IMPORTED, {
    localTrips: [{ id: 'mine', title: 'My Trip', days: 1, local: true, destinations: ['X'] }],
    tripStates: { mine: existing },
  });
  const res = await page.evaluate(async () => {
    _allTripsCache = [{ id: 'mine', title: 'My Trip', shared: false }];
    document.getElementById('import-text').value = 'more stops';
    _importMode = 'append';
    const sel = document.getElementById('import-target-trip');
    sel.innerHTML = '<option value="mine">My Trip</option>';
    sel.value = 'mine';
    await importTrip();
    return {
      queued: JSON.parse(sessionStorage.getItem('pendingImport_mine') || 'null'),
      // The existing trip must be untouched until trip.js merges it properly.
      untouched: JSON.parse(localStorage.getItem('tripState_mine')),
    };
  });
  await page.waitForURL(/id=mine/, { timeout: 15000 });
  assert.ok(Array.isArray(res.queued) && res.queued.length === 2, 'the parsed days are queued for the trip page');
  assert.equal(res.untouched.days.length, 1, 'the existing trip is NOT overwritten here');
  assert.equal(res.untouched.days[0].stops[0]._sid, 'keep-me', 'existing stop data is intact');
  assert.match(page.url(), /id=mine/, 'and we navigate to that trip to do the merge');
  await page.close();
});

// ===========================================================================
// THE WIZARD. The other path that writes a whole trip in one shot: it asks a few
// questions, calls the model, and saves the result. The model call is stubbed so
// these test the app's parsing, saving and error handling — not the model.
// ===========================================================================
const WIZ_TRIP = JSON.stringify({
  title: 'Kyoto Trip',
  mapCenter: [35.01, 135.77], mapZoom: 10,
  days: [
    { title: 'Day 1 — Arrive', subtitle: 'Mon Apr 6 • Kyoto', stops: [
      { name: 'Fushimi Inari', type: 'hike', time: '9:00 AM', endTime: '11:00 AM', lat: 34.967, lng: 135.772 },
      { name: 'Lunch — Nishiki', type: 'food', time: '12:30 PM', endTime: '1:15 PM' },
    ] },
    { title: 'Day 2 — Temples', subtitle: 'Tue Apr 7 • Kyoto', stops: [
      { name: 'Kinkaku-ji', type: 'hike', time: '9:30 AM', endTime: '11:00 AM' },
    ] },
  ],
});

async function openWizard(aiResponse) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    // Nominatim (geocoding) and anything else outbound.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto(`${origin}/Travel/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof generateTrip === 'function', null, { timeout: 15000 });
  await page.evaluate((resp) => {
    window.callClaude = async () => resp;
    // Fill in what the wizard would have collected from the user.
    wizData = { dest: 'Kyoto', startDate: '2026-04-06', endDate: '2026-04-08', days: 3,
      who: 'family', activities: ['culture', 'food'], pace: 'relaxed', budget: 'mid',
      notes: 'kids in tow', budgetTotal: 2400, budgetAmtType: 'total' };
  }, aiResponse);
  return { page, errors };
}

test('the wizard saves a generated trip with all its days and stops', async () => {
  const { page } = await openWizard(WIZ_TRIP);
  await page.evaluate(async () => { await generateTrip(); });
  await page.waitForURL(/trip\.html/, { timeout: 20000 });
  const res = await page.evaluate((nav) => {
    const id = (nav.match(/id=([^&]+)/) || [])[1];
    const t = JSON.parse(localStorage.getItem('tripState_' + id) || 'null');
    const listed = JSON.parse(localStorage.getItem('localTrips') || '[]').find((x) => x.id === id);
    return { id, days: t && t.days.length, stops: t && t.days.reduce((n, d) => n + d.stops.length, 0),
      title: t && t.title, listed: !!listed };
  }, page.url());
  assert.ok(res.id && res.id.startsWith('ai-'), 'an AI trip id was created: ' + res.id);
  assert.equal(res.days, 2);
  assert.equal(res.stops, 3, 'every generated stop was saved');
  assert.equal(res.title, 'Kyoto Trip');
  assert.ok(res.listed, 'and it appears in the trips list');
  await page.close();
});

test('the wizard keeps the answers you gave it on the trip', async () => {
  const { page } = await openWizard(WIZ_TRIP);
  await page.evaluate(async () => { await generateTrip(); });
  await page.waitForURL(/trip\.html/, { timeout: 20000 });
  const meta = await page.evaluate((nav) => {
    const id = (nav.match(/id=([^&]+)/) || [])[1];
    const t = JSON.parse(localStorage.getItem('tripState_' + id) || 'null');
    return t && { meta: t._meta, budget: t.budget };
  }, page.url());
  assert.equal(meta.meta.who, 'family', 'who it is for is remembered');
  assert.equal(meta.meta.pace, 'relaxed');
  assert.equal(JSON.stringify(meta.meta.activities), JSON.stringify(['culture', 'food']));
  assert.equal(meta.budget.total, 2400, 'the budget is carried onto the trip');
  await page.close();
});

test('a malformed AI reply shows an error and creates NO trip', async () => {
  const { page } = await openWizard('Sorry, I could not do that.');
  const res = await page.evaluate(async () => {
    const before = JSON.parse(localStorage.getItem('localTrips') || '[]').length;
    await generateTrip();
    return { before, after: JSON.parse(localStorage.getItem('localTrips') || '[]').length,
      url: location.href };
  });
  await page.waitForTimeout(400);
  assert.equal(res.after, res.before, 'no half-built trip was saved');
  assert.ok(!/trip\.html/.test(page.url()), 'and we did not navigate into one');
  await page.close();
});

test('an AI reply with zero days is refused', async () => {
  const { page } = await openWizard(JSON.stringify({ title: 'Empty', days: [] }));
  const res = await page.evaluate(async () => {
    const before = JSON.parse(localStorage.getItem('localTrips') || '[]').length;
    await generateTrip();
    return { before, after: JSON.parse(localStorage.getItem('localTrips') || '[]').length };
  });
  await page.waitForTimeout(400);
  assert.equal(res.after, res.before, 'a trip with no days must not be saved');
  assert.ok(!/trip\.html/.test(page.url()));
  await page.close();
});

test('the blank-trip path creates the right number of empty days', async () => {
  const { page } = await openWizard(WIZ_TRIP);
  await page.evaluate(async () => { await generateSkeleton(); });
  await page.waitForURL(/trip\.html/, { timeout: 20000 });
  const res = await page.evaluate((nav) => {
    const id = (nav.match(/id=([^&]+)/) || [])[1];
    const t = JSON.parse(localStorage.getItem('tripState_' + id) || 'null');
    return { id, days: t && t.days.length, stops: t && t.days.reduce((n, d) => n + d.stops.length, 0),
      firstTitle: t && t.days[0].title };
  }, page.url());
  assert.ok(res.id && res.id.startsWith('trip-'), 'a blank trip id was created');
  assert.equal(res.days, 3, 'one day per requested day');
  assert.equal(res.stops, 0, 'and no invented stops');
  assert.match(res.firstTitle, /Kyoto/, 'days are titled for the destination');
  await page.close();
});
