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
const XLSX_FILE = SCRATCH + '/node_modules/xlsx/dist/xlsx.full.min.js';

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.mjs': 'application/javascript', '.pdf': 'application/pdf',
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
      // Real SheetJS, not a stub: the Ask AI spreadsheet reader must be proven to
      // actually parse a workbook, not merely to have been called.
      if (u.includes('xlsx') && fs.existsSync(XLSX_FILE)) {
        return route.fulfill({ status: 200, contentType: 'application/javascript',
          body: fs.readFileSync(XLSX_FILE) });
      }
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
  await page.waitForFunction(() => document.getElementById('f-duration').value === '2hrs', null, { timeout: 12000 });
  // Typing a Duration updates End Time.
  await page.fill('#f-duration', '3h');
  await page.dispatchEvent('#f-duration', 'input');
  await page.waitForFunction(() => document.getElementById('f-endtime').value === '15:03', null, { timeout: 12000 });
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

// ===========================================================================
// VISUAL CONSISTENCY of the stop card. "Fix pin" carried an inline
// font:inherit that overrode its chip class, so a maintenance action rendered
// larger than everything else and dominated the card.
// ===========================================================================
test('every action chip on a stop card shares one size', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Royal Horseguards Hotel', type: 'lodge', time: '11:49 AM', endTime: '12:09 PM',
        reservation: '1072991266', ticketImage: 'data:image/png;base64,iVBORw0KGgo=',
        lat: 51.5063, lng: -0.1237 },
    ] },
  ]);
  const chips = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.stop-card .map-link, .stop-card .ticket-view-btn').forEach((el) => {
      const cs = getComputedStyle(el);
      out.push({ text: (el.textContent || '').trim().slice(0, 16),
        size: cs.fontSize, h: Math.round(el.getBoundingClientRect().height) });
    });
    return out;
  });
  assert.ok(chips.length >= 3, 'several chips are present, got ' + chips.length);
  const sizes = [...new Set(chips.map((c) => c.size))];
  const heights = [...new Set(chips.map((c) => c.h))];
  assert.equal(sizes.length, 1, 'chips must share ONE font size, got ' + JSON.stringify(chips));
  assert.equal(heights.length, 1, 'and one height, got ' + JSON.stringify(chips));
  await page.close();
});

test('delete is the last card control and is set apart from the move buttons', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'A', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 55.94, lng: -3.19 },
      { name: 'B', type: 'hike', time: '11:00 AM', endTime: '12:00 PM', lat: 55.95, lng: -3.18 },
    ] },
  ]);
  const info = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.stop-card .card-controls .card-btn')];
    const last = btns[btns.length - 1];
    return { count: btns.length, lastIsDelete: last.classList.contains('delete-btn'),
      gap: parseFloat(getComputedStyle(last).marginLeft),
      labels: btns.map((b) => b.getAttribute('aria-label') || b.title) };
  });
  assert.ok(info.lastIsDelete, 'delete must be last, order was ' + JSON.stringify(info.labels));
  assert.ok(info.gap >= 8, 'delete needs separation from the other controls, got ' + info.gap + 'px');
  // The two move buttons should be adjacent to each other, not split by delete.
  const i1 = info.labels.findIndex((l) => /earlier|up/i.test(l));
  const i2 = info.labels.findIndex((l) => /later|down/i.test(l));
  assert.equal(Math.abs(i1 - i2), 1, 'the move controls sit together: ' + JSON.stringify(info.labels));
  await page.close();
});

// ===========================================================================
// The Edit Stop TIME fields. trip-extras.js monkey-patches openEditStopModal and
// used to overwrite End Time with the stored 12-hour string ("6:29 PM"). Once the
// field became a native <input type="time"> — which only accepts 24h "HH:MM" —
// the browser rejected that value, so End Time appeared EMPTY on every edit.
// ===========================================================================
test('Edit Stop shows BOTH times, and no field is clipped', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Westminster Abbey Lates', type: 'hike', time: '5:09 PM', endTime: '6:29 PM',
        duration: '1h 20min', lat: 51.4994, lng: -0.1273 },
    ] },
  ]);
  await page.evaluate(() => openEditStopModal(0, 0));
  await page.waitForSelector('#f-endtime', { state: 'attached' });
  await page.waitForTimeout(300);
  const f = await page.evaluate(() => {
    const out = {};
    ['f-time', 'f-endtime', 'f-date', 'f-enddate', 'f-duration', 'f-tz', 'f-endtz'].forEach((id) => {
      const el = document.getElementById(id);
      out[id] = { value: el.value, clipped: el.scrollWidth - el.clientWidth };
    });
    return out;
  });
  assert.equal(f['f-time'].value, '17:09', 'start time is populated');
  assert.equal(f['f-endtime'].value, '18:29', 'END TIME must be populated, got "' + f['f-endtime'].value + '"');
  assert.equal(f['f-date'].value, '2026-08-05');
  assert.equal(f['f-enddate'].value, '2026-08-05');
  for (const [id, v] of Object.entries(f)) {
    assert.ok(v.clipped <= 0, id + ' content is clipped by ' + v.clipped + 'px');
  }
  await page.close();
});

// ===========================================================================
// FIELDS MUST NOT OVERLAP. This was reported five times and "fixed" twice by
// eye. Eyes are not a test. These measure the real boxes at several widths and
// fail on a single pixel of overlap.
// ===========================================================================
const OVERLAP_WIDTHS = [1180, 1024, 900, 820, 768, 600, 430, 390];

async function measureRows(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('.field-row-3,.field-row-dur').forEach((row) => {
      const cells = Array.prototype.slice.call(row.children);
      rows.push(cells.map((c) => {
        const ctl = c.querySelector('input,select') || c;
        const cb = c.getBoundingClientRect();
        const ib = ctl.getBoundingClientRect();
        return { id: ctl.id || ctl.className, top: ib.top, left: ib.left, right: ib.right,
          escapes: +(ib.width - cb.width).toFixed(1) };
      }));
    });
    return rows;
  });
}

test('no two Edit Stop fields ever overlap, at any width', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Westminster Abbey', type: 'hike', time: '3:35 PM', endTime: '4:35 PM',
        duration: '1h', lat: 51.4994, lng: -0.1273 },
    ] },
  ]);
  await page.evaluate(() => openEditStopModal(0, 0));
  await page.waitForSelector('#f-endtime', { state: 'attached' });
  for (const w of OVERLAP_WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate(() => _fitFieldRows());
    await page.waitForTimeout(60);
    const rows = await measureRows(page);
    for (const cells of rows) {
      for (const c of cells) {
        assert.ok(c.escapes <= 0.5,
          `at ${w}px, ${c.id} is ${c.escapes}px wider than the cell holding it`);
      }
      for (let i = 0; i < cells.length - 1; i++) {
        const a = cells[i], b = cells[i + 1];
        if (Math.abs(a.top - b.top) > 2) continue;   // different visual line
        assert.ok(a.right <= b.left + 0.5,
          `at ${w}px, ${a.id} overlaps ${b.id} by ${(a.right - b.left).toFixed(1)}px`);
      }
    }
  }
  await page.close();
});

// The runtime fallback must actually engage when a control refuses to shrink —
// which is exactly what iOS Safari does with a native date/time control and what
// no browser available here reproduces. Force the condition and assert the row
// stacks instead of overlapping.
test('a control that refuses to shrink makes the row stack, not overlap', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Westminster Abbey', type: 'hike', time: '3:35 PM', endTime: '4:35 PM',
        lat: 51.4994, lng: -0.1273 },
    ] },
  ]);
  await page.evaluate(() => openEditStopModal(0, 0));
  await page.waitForSelector('#f-date', { state: 'attached' });
  // Simulate the iOS control: intrinsic width, immune to width:100%.
  const res = await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '#f-date{width:420px !important;min-width:420px !important;max-width:none !important}';
    document.head.appendChild(st);
    const row = document.getElementById('f-date').closest('.field-row-3');
    const before = row.classList.contains('stacked');
    _fitFieldRows();
    const after = row.classList.contains('stacked');
    const cells = Array.prototype.slice.call(row.children)
      .map((c) => (c.querySelector('input') || c).getBoundingClientRect());
    let overlap = 0;
    for (let i = 0; i < cells.length - 1; i++) {
      if (Math.abs(cells[i].top - cells[i + 1].top) > 2) continue;
      overlap = Math.max(overlap, cells[i].right - cells[i + 1].left);
    }
    return { before, after, overlap: +overlap.toFixed(1) };
  });
  assert.equal(res.before, false, 'the row starts un-stacked');
  assert.equal(res.after, true, 'an oversized control must force the row to stack');
  assert.ok(res.overlap <= 0.5, 'and after stacking nothing overlaps, got ' + res.overlap + 'px');
  await page.close();
});

// ===========================================================================
// TRANSIT LEGS ON THE MAP. Ground segmentation (v169) excludes flights/trains
// from ROAD routing — you cannot drive the Atlantic — but that is a routing
// decision, NOT a reason to hide the journey. Every flight, train and bus gets
// its own straight leg. Anything else leaves pins with nothing joining them.
// ===========================================================================
test('a train journey is drawn on the map', async () => {
  const { page } = await openTrip([
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Gatwick Express to London Victoria', type: 'train', time: '9:30 AM', endTime: '10:00 AM',
        lat: 51.1537, lng: -0.1821, destLat: 51.4952, destLng: -0.1441 },
      { name: 'British Museum', type: 'hike', time: '11:00 AM', endTime: '1:00 PM',
        lat: 51.5194, lng: -0.127 },
    ] },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('#map .leaflet-overlay-pane path').length > 0,
    null, { timeout: 15000 });
  const legs = await page.evaluate(() => _transitLegs(state.days[0].stops));
  assert.equal(legs.length, 1, 'the train is one transit leg');
  assert.equal(legs[0].mode, 'train');
  assert.equal(legs[0].to[0], 51.4952, 'it ends at Victoria, its stated destination');
  const paths = await page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length);
  assert.ok(paths >= 1, 'and a line is actually rendered, got ' + paths);
  await page.close();
});

test('a transit leg with no destination coords uses the next stop', async () => {
  const { page } = await openTrip([
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      // No destLat/destLng — this is how most imported trains look.
      { name: 'Gatwick Express', type: 'train', time: '9:30 AM', endTime: '10:00 AM',
        lat: 51.1537, lng: -0.1821 },
      { name: 'Royal Horseguards Hotel', type: 'lodge', time: '10:30 AM', endTime: '11:00 AM',
        lat: 51.5063, lng: -0.1237 },
    ] },
  ]);
  const legs = await page.evaluate(() => _transitLegs(state.days[0].stops));
  assert.equal(legs.length, 1, 'the train still produces a leg');
  assert.equal(legs[0].to[0], 51.5063, 'it runs to the next located stop');
  await page.close();
});

test('the train leg on the REAL trip Day 2 is drawn', async () => {
  const trip = JSON.parse(fs.readFileSync(path.join(ROOT, 'trips', 'london-scotland.json'), 'utf8'));
  const { page } = await openTrip(trip.days, { day: 1 });
  const info = await page.evaluate(() => ({
    legs: _transitLegs(state.days[1].stops).map((l) => l.mode),
    paths: document.querySelectorAll('#map .leaflet-overlay-pane path').length,
  }));
  assert.ok(info.legs.includes('train'), 'Day 2 has a train leg, got ' + JSON.stringify(info.legs));
  assert.ok(info.paths >= 2, 'the map draws the transit leg AND the ground route, got ' + info.paths);
  await page.close();
});

// A flight that ENDS the day has no later stop on its own day to draw to, so
// it silently produced zero legs: the Day 1 transatlantic flight was invisible.
// The destination is where the NEXT day begins.
test('a flight that ends the day draws to where the next day starts', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Drive to MCO', type: 'drive', time: '2:00 PM', endTime: '3:30 PM',
        lat: 28.2442, lng: -82.7193 },
      { name: 'Flight MCO to LGW', type: 'flight', time: '6:55 PM', endTime: '8:45 AM',
        lat: 28.4312, lng: -81.3081 },
    ] },
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Gatwick Arrival', type: 'sight', time: '8:45 AM', endTime: '9:30 AM',
        lat: 51.1537, lng: -0.1821 },
    ] },
  ]);
  const legs = await page.evaluate(
    () => _transitLegs(state.days[0].stops, state.days[1].stops));
  assert.equal(legs.length, 1, 'the ocean crossing is one leg, got ' + legs.length);
  assert.equal(legs[0].mode, 'flight');
  assert.ok(Math.abs(legs[0].to[0] - 51.1537) < 0.01,
    'it lands at Gatwick, day 2\'s first stop, got ' + legs[0].to[0]);
  const paths = await page.evaluate(
    () => document.querySelectorAll('#map .leaflet-overlay-pane path').length);
  assert.ok(paths >= 1, 'and the flight line is actually rendered, got ' + paths);
  await page.close();
});

test('the REAL trip Day 1 transatlantic flight is drawn', async () => {
  const trip = JSON.parse(fs.readFileSync(path.join(ROOT, 'trips', 'london-scotland.json'), 'utf8'));
  const { page } = await openTrip(trip.days, { day: 0 });
  // Day 1 is a single stop: the flight itself. Before v186 that meant NO line
  // at all — the leg had no later stop on its own day to end at.
  await page.waitForFunction(
    () => document.querySelectorAll('#map .leaflet-overlay-pane path').length > 0,
    null, { timeout: 15000 });
  const info = await page.evaluate(() => ({
    legs: _transitLegs(state.days[0].stops, (state.days[1] || {}).stops).map((l) => l.mode),
    paths: document.querySelectorAll('#map .leaflet-overlay-pane path').length,
  }));
  assert.ok(info.legs.includes('flight'),
    'Day 1 draws its flight, got ' + JSON.stringify(info.legs));
  assert.ok(info.paths >= 1,
    'the flight line is rendered on Day 1, got ' + info.paths);
  await page.close();
});

// ===========================================================================
// ASK AI ATTACHMENTS. A booking confirmation is a file, so the chat has to be
// able to read one. Everything is extracted in the browser; the AI proxy takes
// text only, so anything that cannot become text must SAY so rather than be
// silently dropped into a prompt the model never sees.
// ===========================================================================
const CHAT_DAY = [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
  { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM', lat: 51.5194, lng: -0.127 },
] }];

// Drop files onto the chat exactly the way a paste does: a real DataTransfer
// carrying real File objects, dispatched as a real paste event.
async function attach(page, files) {
  await page.evaluate(async (fs_) => {
    const dt = new DataTransfer();
    for (const f of fs_) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type || '' }));
    }
    document.getElementById('pc-content')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, files);
  await page.waitForFunction(
    () => !document.querySelector('#pc-attach .pc-file-load'), null, { timeout: 20000 });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function openChat(page) {
  await page.evaluate(() => openPlanChat());
  await page.waitForSelector('#pc-input', { state: 'attached' });
}

test('pasting a text confirmation attaches it and sends its contents', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  await attach(page, [{ name: 'hotel.txt', type: 'text/plain',
    b64: b64('Royal Horseguards. Confirmation VZ88421. Check in Aug 5 2026 15:00.') }]);

  const tray = await page.evaluate(() => ({
    shown: getComputedStyle(document.getElementById('pc-attach')).display,
    names: Array.from(document.querySelectorAll('.pc-file-name')).map((n) => n.textContent),
    bad: document.querySelectorAll('.pc-file-bad').length,
  }));
  assert.equal(tray.shown, 'flex', 'the attachment tray must appear');
  assert.deepEqual(tray.names, ['hotel.txt']);
  assert.equal(tray.bad, 0, 'a plain text file must not be reported as unreadable');

  // What the model actually receives.
  const sent = await page.evaluate(() => _pcComposeMessage('When do I check in?'));
  assert.match(sent, /=== ATTACHED FILE: hotel\.txt ===/);
  assert.match(sent, /VZ88421/, 'the confirmation number must reach the model');
  assert.match(sent, /When do I check in\?$/, 'the question comes after the file');
  await page.close();
});

test('an attached file is actually put on the wire when you hit send', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  // Capture the outbound request instead of trusting that compose was called.
  await page.evaluate(() => {
    window.__sent = [];
    window.fetch = async (u, o) => {
      window.__sent.push({ url: String(u), body: o && o.body });
      return { ok: true, json: async () => ({ content: [{ text: 'Noted.' }] }) };
    };
  });
  await attach(page, [{ name: 'flight.txt', type: 'text/plain',
    b64: b64('Norse Atlantic Z0 784, MCO to LGW, 4 Aug 2026, seat 21A, ref QK7T2M') }]);
  await page.evaluate(() => { document.getElementById('pc-input').value = 'Is this on my itinerary?'; });
  await page.evaluate(() => _planSendMessage());
  await page.waitForFunction(() => window.__sent.length > 0, null, { timeout: 15000 });

  const body = await page.evaluate(() => JSON.parse(window.__sent[0].body));
  assert.match(body.user, /QK7T2M/, 'the booking reference must be in the request body');
  assert.match(body.user, /ATTACHED FILE: flight\.txt/);
  assert.match(body.user, /Is this on my itinerary\?/);
  // And the tray clears, so the same file is not re-sent with the next question.
  const left = await page.evaluate(() => document.querySelectorAll('.pc-file').length);
  assert.equal(left, 0, 'the tray clears after sending');
  await page.close();
});

test('a real PDF confirmation is read', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  const pdf = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'confirmation.pdf')).toString('base64');
  await attach(page, [{ name: 'confirmation.pdf', type: 'application/pdf', b64: pdf }]);
  const info = await page.evaluate(() => ({
    bad: document.querySelectorAll('.pc-file-bad').length,
    meta: document.querySelector('.pc-file-meta')?.textContent || '',
    sent: _pcComposeMessage('what is this?'),
  }));
  assert.equal(info.bad, 0, 'the PDF must be readable, tray said: ' + info.meta);
  assert.match(info.sent, /ABC123/, 'text inside the PDF must reach the model');
  assert.match(info.sent, /Z0 784/);
  await page.close();
});

test('a spreadsheet is flattened to text the model can read', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  // Build a genuine .xlsx in the page with the same SheetJS the app uses.
  await page.waitForFunction(() => typeof XLSX !== 'undefined', null, { timeout: 15000 });
  await page.evaluate(async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,
      XLSX.utils.aoa_to_sheet([['Day', 'Stop', 'Ref'], [2, 'Gatwick Express', 'GX9911']]), 'Bookings');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const dt = new DataTransfer();
    dt.items.add(new File([out], 'bookings.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    document.getElementById('pc-content')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.pc-file').length === 1
    && !document.querySelector('.pc-file-load'), null, { timeout: 20000 });
  const info = await page.evaluate(() => ({
    bad: document.querySelectorAll('.pc-file-bad').length,
    meta: document.querySelector('.pc-file-meta')?.textContent || '',
    sent: _pcComposeMessage('anything missing?'),
  }));
  assert.equal(info.bad, 0, 'the workbook must be readable, tray said: ' + info.meta);
  assert.match(info.sent, /GX9911/, 'a cell value must reach the model');
  assert.match(info.sent, /sheet: Bookings/, 'sheets are labelled');
  await page.close();
});

test('an image is refused out loud, never silently dropped', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await attach(page, [{ name: 'screenshot.png', type: 'image/png', b64: png }]);
  const info = await page.evaluate(() => ({
    bad: document.querySelectorAll('.pc-file-bad').length,
    meta: document.querySelector('.pc-file-bad .pc-file-meta')?.textContent || '',
    sent: _pcComposeMessage('read this'),
  }));
  assert.equal(info.bad, 1, 'the image must be flagged');
  assert.match(info.meta, /image/i, 'and it must say why: ' + info.meta);
  assert.equal(info.sent, 'read this', 'nothing unreadable is smuggled into the prompt');
  await page.close();
});

test('a huge file is truncated with a notice, not silently cut', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  await attach(page, [{ name: 'big.txt', type: 'text/plain', b64: b64('x'.repeat(200000)) }]);
  const info = await page.evaluate(() => ({
    meta: document.querySelector('.pc-file-meta')?.textContent || '',
    sent: _pcComposeMessage('summarise'),
  }));
  assert.match(info.meta, /trimmed/i, 'the tray says it was trimmed: ' + info.meta);
  assert.match(info.sent, /truncated/i, 'and the model is told the file is incomplete');
  await page.close();
});

test('attachments can be removed, and the same file is not added twice', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  const f = { name: 'a.txt', type: 'text/plain', b64: b64('hello') };
  await attach(page, [f]);
  await attach(page, [f]);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.pc-file').length), 1,
    'the same file pasted twice stays one attachment');
  await page.evaluate(() => document.querySelector('.pc-file-x').click());
  assert.equal(await page.evaluate(() => document.querySelectorAll('.pc-file').length), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('pc-attach')).display), 'none',
    'the empty tray hides itself');
  await page.close();
});

test('a file alone, with no typed question, is still a valid message', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  await page.evaluate(() => {
    window.__sent = [];
    window.fetch = async (u, o) => { window.__sent.push(o && o.body);
      return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) }; };
  });
  await attach(page, [{ name: 'ticket.txt', type: 'text/plain', b64: b64('Ref RJ4419 Edinburgh Waverley 09:12') }]);
  await page.evaluate(() => _planSendMessage());        // input left empty on purpose
  await page.waitForFunction(() => window.__sent.length > 0, null, { timeout: 15000 });
  const body = await page.evaluate(() => JSON.parse(window.__sent[0]));
  assert.match(body.user, /RJ4419/);
  await page.close();
});

// ===========================================================================
// TIME ZONES. A three-letter abbreviation cannot identify a zone. "IST" is
// Irish Standard Time (+1) in Dublin and India Standard Time (+5:30) in Delhi,
// and the app resolved it to India — a silent 4.5-hour error on a UK and
// Ireland trip. The guard entry written to prevent that (IST_IE) could never
// match, because the lookup strips non-letters. Location decides now.
// ===========================================================================
test('IST on a stop in Ireland is Irish time, not Indian time', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Dublin Airport', type: 'flight', tz: 'IST', endTz: 'IST',
        time: '9:00 AM', endTime: '10:30 AM', startDate: '2026-08-05', endDate: '2026-08-05',
        lat: 53.4264, lng: -6.2499 },
    ] },
  ]);
  const out = await page.evaluate(() => {
    // Teach the app where this stop is, the same way its own lookup would.
    tzData[tzKey(53.4264, -6.2499)] = { tz: 'Europe/Dublin' };
    const s = state.days[0].stops[0];
    return { zone: _startZone(s), offset: _zoneOffsetMins(_startZone(s), '2026-08-05', '9:00 AM') };
  });
  assert.equal(out.zone, 'Europe/Dublin', 'IST in Dublin must resolve to Ireland, got ' + out.zone);
  assert.equal(out.offset, 60, 'Irish Summer Time is +1:00, got ' + out.offset + ' minutes');
});

test('IST on a stop in India is still Indian time', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Delhi', type: 'hike', tz: 'IST', time: '9:00 AM', endTime: '10:30 AM',
        startDate: '2026-08-05', lat: 28.6139, lng: 77.209 },
    ] },
  ]);
  const off = await page.evaluate(() => {
    tzData[tzKey(28.6139, 77.209)] = { tz: 'Asia/Kolkata' };
    return _zoneOffsetMins(_startZone(state.days[0].stops[0]), '2026-08-05', '9:00 AM');
  });
  assert.equal(off, 330, 'India is +5:30, got ' + off);
});

test('an ambiguous zone with no location gives no offset rather than a wrong one', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Somewhere', type: 'hike', tz: 'IST', time: '9:00 AM', endTime: '10:00 AM' },
    ] },
  ]);
  const off = await page.evaluate(() =>
    _zoneOffsetMins(_startZone(state.days[0].stops[0]), '2026-08-05', '9:00 AM'));
  assert.equal(off, null, 'unknown must be null, not a confident guess, got ' + off);
});

test('the end zone of a journey resolves at the DESTINATION, not the origin', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      // Leaves Chicago (CST) and lands in Shanghai (also called CST).
      { name: 'ORD to PVG', type: 'flight', tz: 'CST', endTz: 'CST',
        time: '1:00 PM', endTime: '4:00 PM', startDate: '2026-08-04', endDate: '2026-08-05',
        lat: 41.9742, lng: -87.9073, destLat: 31.1443, destLng: 121.8083 },
    ] },
  ]);
  const out = await page.evaluate(() => {
    tzData[tzKey(41.9742, -87.9073)] = { tz: 'America/Chicago' };
    tzData[tzKey(31.1443, 121.8083)] = { tz: 'Asia/Shanghai' };
    const s = state.days[0].stops[0];
    return { start: _startZone(s), end: _endZone(s) };
  });
  assert.equal(out.start, 'America/Chicago');
  assert.equal(out.end, 'Asia/Shanghai', 'the same letters mean China at the far end, got ' + out.end);
});

test('an unambiguous abbreviation is still honoured as typed', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'London', type: 'hike', tz: 'BST', time: '9:00 AM', endTime: '10:00 AM',
        startDate: '2026-08-05', lat: 51.5, lng: -0.12 },
    ] },
  ]);
  const out = await page.evaluate(() => ({
    zone: _startZone(state.days[0].stops[0]),
    off: _zoneOffsetMins('BST', '2026-08-05', '9:00 AM'),
  }));
  assert.equal(out.zone, 'BST', 'BST is unambiguous and must not be rewritten');
  assert.equal(out.off, 60);
});

test('the zone picker offers no ambiguous abbreviation', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'X', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 51.5, lng: -0.12 },
    ] },
  ]);
  const opts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#tz-list option')).map((o) => o.value));
  assert.ok(opts.length > 5, 'the picker still offers zones, got ' + opts.length);
  for (const bad of ['IST', 'CST', 'AST', 'GST']) {
    assert.ok(!opts.includes(bad), bad + ' is ambiguous and must not be offered as a choice');
  }
  assert.ok(opts.includes('Europe/Dublin') && opts.includes('Asia/Kolkata'),
    'both meanings of IST are offered explicitly instead');
});

// ===========================================================================
// THE MERGE (v190). trip-extras.js used to load after trip.js and reassign
// window.saveStop, window.openEditStopModal and window._planCallAI. A function
// could therefore have two definitions with only the later one running — which
// is how the attachment rules added to PLAN_CHAT_SYSTEM never reached the model
// at all, and how a fix to saveStop could be silently undone.
// ===========================================================================
test('the page loads exactly one script that defines app behaviour', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'trip.html'), 'utf8');
  assert.ok(!/<script src="trip-extras\.js/.test(html),
    'trip-extras.js must no longer be loaded');
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'X', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 51.5, lng: -0.12 },
    ] },
  ]);
  // The functions that used to be reassigned are plain declarations now, and the
  // window property and the binding must be the same object.
  const same = await page.evaluate(() => ({
    saveStop: window.saveStop === saveStop,
    openEdit: window.openEditStopModal === openEditStopModal,
    planCall: window._planCallAI === _planCallAI,
  }));
  assert.deepEqual(same, { saveStop: true, openEdit: true, planCall: true },
    'no function may be shadowed by a second definition');
  await page.close();
});

test('the system prompt actually sent contains the attachment rules', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.5194, lng: -0.127 },
    ] },
  ]);
  await page.evaluate(() => openPlanChat());
  await page.waitForSelector('#pc-input', { state: 'attached' });
  await page.evaluate(() => {
    window.__sent = [];
    window.fetch = async (u, o) => { window.__sent.push(o && o.body);
      return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) }; };
  });
  await page.evaluate(() => { document.getElementById('pc-input').value = 'hello'; });
  await page.evaluate(() => _planSendMessage());
  await page.waitForFunction(() => window.__sent.length > 0, null, { timeout: 15000 });
  const body = await page.evaluate(() => JSON.parse(window.__sent[0]));
  // Before the merge these rules lived on PLAN_CHAT_SYSTEM, which nothing sent.
  assert.match(body.system, /ATTACHED FILE markers/,
    'the attachment rules must be in the prompt that is actually transmitted');
  assert.match(body.system, /ITINERARY_CHANGES/,
    'and it must still be the change-capable prompt, not the read-only one');
  assert.match(body.system, /LIVE ITINERARY/, 'with the itinerary index map appended');
  await page.close();
});

test('the card augmentation merged out of trip-extras still runs', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.5194, lng: -0.127 },
    ] },
  ]);
  await page.waitForFunction(
    () => !!document.querySelector('.stop-card .card-endtime'), null, { timeout: 15000 });
  const txt = await page.evaluate(() => document.querySelector('.card-endtime').textContent);
  assert.match(txt, /12:00 PM/, 'the end time is still drawn on the card, got ' + txt);
  await page.close();
});

test('the audio-tour field still pre-fills when editing a stop', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Westminster', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.4994, lng: -0.1273, audioUrl: 'https://example.com/tour.mp3' },
    ] },
  ]);
  await page.evaluate(() => openEditStopModal(0, 0));
  await page.waitForSelector('#f-audiourl', { state: 'attached' });
  const v = await page.evaluate(() => document.getElementById('f-audiourl').value);
  assert.equal(v, 'https://example.com/tour.mp3',
    'the prefill that lived in the openEditStopModal wrapper must survive the merge');
  await page.close();
});

// ===========================================================================
// THE WRITE PATH (v191). 67 places mutated state.days directly and 41 called
// saveState, so a rule stated once held only where it had been wired in by
// hand. commit() is now the one way in: snapshot, apply, validate, roll back,
// record.
// ===========================================================================
const WP_DAY = [
  { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
    { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
      lat: 51.5194, lng: -0.127, reservation: 'BM-4471', notes: 'Rosetta Stone first' },
    { name: 'Dishoom', type: 'food', time: '1:00 PM', endTime: '1:45 PM',
      lat: 51.5115, lng: -0.1265 },
    { name: 'Royal Horseguards', type: 'lodge', time: '8:00 PM', endTime: '9:00 PM',
      lat: 51.5063, lng: -0.1237 },
  ] },
  { title: 'Day 2', subtitle: 'Thu, Aug 6, 2026', stops: [
    { name: 'Tower of London', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
      lat: 51.5081, lng: -0.0759 },
  ] },
];

test('a commit that breaks the itinerary structure is rolled back', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    const before = JSON.stringify(state);
    const ok = commit('corrupt it', () => { state.days[0].stops = 'not an array'; }, WRITE.USER);
    return { ok, restored: JSON.stringify(state) === before, stops: state.days[0].stops.length };
  });
  assert.equal(out.ok, false, 'the commit must be refused');
  assert.ok(out.restored, 'and the itinerary must be exactly as it was');
  assert.equal(out.stops, 3);
  await page.close();
});

test('a commit that would delete most of the trip is refused', async () => {
  // The brake engages at six stops or more: below that, emptying a day is a
  // plausible edit rather than a catastrophe. Pinned here so the threshold
  // cannot drift without a test saying so.
  const big = [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops:
    Array.from({ length: 8 }, (_, i) => ({ name: 'Stop ' + (i + 1), type: 'hike',
      time: (9 + i) + ':00 AM', endTime: (10 + i) + ':00 AM', lat: 51.5 + i / 100, lng: -0.12 })) }];
  const { page } = await openTrip(big);
  const out = await page.evaluate(() => {
    const ok = commit('wipe it', () => { state.days.forEach((d) => { d.stops = []; }); }, WRITE.USER);
    return { ok, total: state.days.reduce((n, d) => n + d.stops.length, 0) };
  });
  assert.equal(out.ok, false, 'catastrophic loss must not be writable');
  assert.equal(out.total, 8, 'every stop is still there, got ' + out.total);
  await page.close();
});

test('the catastrophic-loss brake does not block an ordinary small edit', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    const ok = commit('tidy day 2', () => { state.days[1].stops = []; }, WRITE.USER);
    return { ok, d1: state.days[0].stops.length, d2: state.days[1].stops.length };
  });
  assert.equal(out.ok, true, 'clearing one small day is a legitimate edit');
  assert.equal(out.d1, 3, 'and it must not touch the other day');
  assert.equal(out.d2, 0);
  await page.close();
});

test('an impossible coordinate is repaired instead of rejecting the whole edit', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    const ok = commit('rename and break a pin', () => {
      state.days[0].stops[1].name = 'Dishoom Covent Garden';
      state.days[0].stops[1].lat = 999;
    }, WRITE.USER);
    return { ok, name: state.days[0].stops[1].name, lat: state.days[0].stops[1].lat };
  });
  assert.equal(out.ok, true, 'the edit still goes through');
  assert.equal(out.name, 'Dishoom Covent Garden', 'the good part of the edit is kept');
  assert.equal(out.lat, undefined, 'the impossible coordinate is dropped, got ' + out.lat);
  await page.close();
});

test('losing a reservation number is recorded, not silent', async () => {
  const { page } = await openTrip(WP_DAY);
  const log = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    commit('rebuild the museum stop', () => {
      // Exactly what saveStop used to do: replace the stop with a form-built one
      // that has no input for reservation or notes.
      state.days[0].stops[0] = { name: 'British Museum', type: 'hike', time: '10:00 AM',
        endTime: '12:00 PM', lat: 51.5194, lng: -0.127 };
    }, WRITE.USER);
    return _loadChangeLog();
  });
  const last = log[log.length - 1];
  assert.ok(last.losses && last.losses.length, 'the loss must be recorded, got ' + JSON.stringify(last));
  assert.ok(last.losses.some((l) => /reservation/.test(l)),
    'the reservation number specifically, got ' + JSON.stringify(last.losses));
  assert.ok(last.losses.some((l) => /notes/.test(l)));
  await page.close();
});

test('a change made outside the write path is caught on the next commit', async () => {
  const { page } = await openTrip(WP_DAY);
  const log = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    state.days[0].stops[0].name = 'Sneaky rename';   // bypasses commit entirely
    commit('an honest edit', () => { state.days[1].stops[0].notes = 'book ahead'; }, WRITE.USER);
    return _loadChangeLog();
  });
  assert.ok(log.some((e) => e.untracked),
    'the rogue mutation must be flagged, log was ' + JSON.stringify(log));
  await page.close();
});

test('every commit records who made it', async () => {
  const { page } = await openTrip(WP_DAY);
  const sources = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    commit('user edit', () => { state.days[0].stops[0].notes = 'a'; }, WRITE.USER);
    commit('ai edit', () => { state.days[0].stops[0].notes = 'b'; }, WRITE.AI);
    commit('cloud copy', () => { state.days[0].stops[0].notes = 'c'; }, WRITE.CLOUD);
    return _loadChangeLog().map((e) => e.source);
  });
  assert.deepEqual(sources, ['user', 'ai', 'cloud'],
    'each change is attributed, got ' + JSON.stringify(sources));
  await page.close();
});

test('deleting a stop goes through the write path and is logged', async () => {
  const { page } = await openTrip(WP_DAY);
  await page.evaluate(() => { window.confirm = () => true; });
  const out = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    deleteStop(0, 1);
    return { stops: state.days[0].stops.map((s) => s.name), log: _loadChangeLog() };
  });
  assert.deepEqual(out.stops, ['British Museum', 'Royal Horseguards']);
  assert.ok(out.log.some((e) => /Removed Dishoom/.test(e.desc)),
    'the deletion is named in the log, got ' + JSON.stringify(out.log.map((e) => e.desc)));
  assert.ok(!out.log.some((e) => e.untracked), 'and it is not reported as a rogue write');
  await page.close();
});

test('moving a stop goes through the write path and is logged', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    moveStop(0, 1, -1);
    return { stops: state.days[0].stops.map((s) => s.name), log: _loadChangeLog() };
  });
  assert.equal(out.stops[0], 'Dishoom', 'the move happened');
  assert.ok(out.log.some((e) => /Moved Dishoom earlier/.test(e.desc)),
    'and it is named in the log, got ' + JSON.stringify(out.log.map((e) => e.desc)));
  assert.ok(!out.log.some((e) => e.untracked));
  await page.close();
});

test('a commit whose mutation throws leaves the itinerary untouched', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    const before = JSON.stringify(state);
    let threw = false;
    try {
      commit('half an edit', () => {
        state.days[0].stops[0].name = 'Half applied';
        throw new Error('boom');
      }, WRITE.USER);
    } catch (e) { threw = true; }
    return { threw, restored: JSON.stringify(state) === before, name: state.days[0].stops[0].name };
  });
  assert.ok(out.threw, 'the error still surfaces');
  assert.ok(out.restored, 'but nothing is half-applied, name was ' + out.name);
  await page.close();
});
