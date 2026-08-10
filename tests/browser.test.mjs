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
async function openTrip(days, { tripId = 'london-scotland', day = 0, family = false, timezoneId = null } = {}) {
  // A page in a specific timezone needs its own context — used to prove the
  // weather reads the DESTINATION's clock rather than the device's.
  const page = timezoneId
    ? await (await browser.newContext({ timezoneId, serviceWorkers: 'block' })).newPage()
    : await browser.newPage();
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
  await page.evaluate(async () => openEditStopModal(0, 0));
  await page.waitForSelector('#f-duration', { state: 'attached' });
  // Opening the form must already show the TRUE span, not the stale "2hrs".
  const shown = await page.inputValue('#f-duration');
  assert.equal(shown, '4h 9min', 'duration derived from the times on open, got ' + shown);
  // The sync handler is an inline oninput, so it runs SYNCHRONOUSLY with the
  // event — there is nothing to wait for. Polling for the result was a race
  // that made this test fail intermittently under load.
  const dur = await page.evaluate(() => {
    const e = document.getElementById('f-endtime');
    e.value = '14:03';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    return document.getElementById('f-duration').value;
  });
  assert.equal(dur, '2hrs', 'a new End Time updates Duration, got ' + dur);
  const end = await page.evaluate(() => {
    const d = document.getElementById('f-duration');
    d.value = '3h';
    d.dispatchEvent(new Event('input', { bubbles: true }));
    return document.getElementById('f-endtime').value;
  });
  assert.equal(end, '15:03', 'and a new Duration updates End Time, got ' + end);
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
  await page.evaluate(async () => switchDay(-1));
  await page.waitForFunction(() => /lodge-card/.test(document.getElementById('content-area').innerHTML), null, { timeout: 8000 });
  surfaces.push(['overview lodging card', await page.innerHTML('#content-area')]);
  // 2. The end-of-day "Tonight" bookend.
  await page.evaluate(async () => switchDay(1));
  await page.waitForFunction(() => /hotel-bookend/.test(document.getElementById('content-area').innerHTML), null, { timeout: 8000 });
  surfaces.push(['day hotel bookend', await page.innerHTML('#content-area')]);
  // 3. The hotel's own stop card.
  await page.evaluate(async () => switchDay(0));
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
    dayHours: '10:00 AM - 5:00 PM', dayHoursSrc: 'osm',
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
      dayHoursSrc: s.dayHoursSrc, lat: s.lat, reservation: s.reservation, url: s.url };
  });
  assert.equal(after.sid, 'sid-keep');
  assert.equal(after.guidebook, 'GUIDEBOOK TEXT');
  assert.equal(after.dayHours, '10:00 AM - 5:00 PM');
  assert.equal(after.dayHoursSrc, 'osm');
  assert.equal(after.lat, 51.5194);
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
  // Wait for the navigation to COMMIT, not for the full load event. The trip
  // page boots Leaflet and the whole itinerary, so "load" is slow and got slower
  // as the itinerary grew — this test only needs the URL and localStorage, both
  // of which are set before the new page finishes loading.
  await page.waitForURL(/trip\.html/, { timeout: 30000, waitUntil: 'commit' });
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
  // Wait for the navigation to COMMIT, not for the full load event. The trip
  // page boots Leaflet and the whole itinerary, so "load" is slow and got slower
  // as the itinerary grew — this test only needs the URL and localStorage, both
  // of which are set before the new page finishes loading.
  await page.waitForURL(/trip\.html/, { timeout: 30000, waitUntil: 'commit' });
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
  // waitForURL resolves while the new document is still swapping in, so an
  // evaluate here can hit a destroyed execution context. Waiting on the app's
  // own `state` is NOT the fix — trip.js may not finish initialising under the
  // wizard's route handler. Waiting for the document is enough and is what the
  // race is actually about.
  await page.waitForLoadState('domcontentloaded');
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
  // waitForURL resolves while the new document is still swapping in, so an
  // evaluate here can hit a destroyed execution context. Waiting on the app's
  // own `state` is NOT the fix — trip.js may not finish initialising under the
  // wizard's route handler. Waiting for the document is enough and is what the
  // race is actually about.
  await page.waitForLoadState('domcontentloaded');
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
  // waitForURL resolves while the new document is still swapping in, so an
  // evaluate here can hit a destroyed execution context. Waiting on the app's
  // own `state` is NOT the fix — trip.js may not finish initialising under the
  // wizard's route handler. Waiting for the document is enough and is what the
  // race is actually about.
  await page.waitForLoadState('domcontentloaded');
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
  await page.evaluate(async () => openEditStopModal(0, 0));
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
  await page.evaluate(async () => openEditStopModal(0, 0));
  await page.waitForSelector('#f-endtime', { state: 'attached' });
  for (const w of OVERLAP_WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate(async () => _fitFieldRows());
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
  await page.evaluate(async () => openEditStopModal(0, 0));
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
  const legs = await page.evaluate(async () => _transitLegs(state.days[0].stops));
  assert.equal(legs.length, 1, 'the train is one transit leg');
  assert.equal(legs[0].mode, 'train');
  assert.equal(legs[0].to[0], 51.4952, 'it ends at Victoria, its stated destination');
  const paths = await page.evaluate(async () => document.querySelectorAll('#map .leaflet-overlay-pane path').length);
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
  const legs = await page.evaluate(async () => _transitLegs(state.days[0].stops));
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


// Capture the AI request specifically. The family sync polls every 3 seconds
// through the same window.fetch, so "the first request captured" is a race.
async function captureAiRequest(page) {
  await page.evaluate(() => {
    window.__sent = [];
    const real = window.fetch;
    window.fetch = async (u, o) => {
      const url = String(u && u.url ? u.url : u);
      const body = o && o.body;
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { /* not JSON */ }
      if (parsed && typeof parsed.system === 'string') {
        // Rendering a day fires AI calls of its own — the morning briefing, the
        // opening-hours fill, stop descriptions. They race whatever the test
        // deliberately sent, and __sent[0] would sometimes be one of them. They
        // are answered (so the app behaves normally) but never recorded.
        const bg = ['charismatic tour guide', 'travel guidebook author',
          'typical opening hours for attractions'];
        if (!bg.some((m) => parsed.system.includes(m))) window.__sent.push({ url, body, parsed });
        return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) };
      }
      return real ? real(u, o) : { ok: true, json: async () => ({}) };
    };
  });
}
async function aiRequestBody(page) {
  await page.waitForFunction(() => window.__sent.length > 0, null, { timeout: 20000 });
  return page.evaluate(() => window.__sent[0].parsed);
}

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
  await page.evaluate(async () => openPlanChat());
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
  const sent = await page.evaluate(async () => _pcComposeMessage('When do I check in?'));
  assert.match(sent, /=== ATTACHED FILE: hotel\.txt ===/);
  assert.match(sent, /VZ88421/, 'the confirmation number must reach the model');
  assert.match(sent, /When do I check in\?$/, 'the question comes after the file');
  await page.close();
});

test('an attached file is actually put on the wire when you hit send', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  // Capture the outbound request instead of trusting that compose was called.
  await captureAiRequest(page);
  await attach(page, [{ name: 'flight.txt', type: 'text/plain',
    b64: b64('Norse Atlantic Z0 784, MCO to LGW, 4 Aug 2026, seat 21A, ref QK7T2M') }]);
  await page.evaluate(() => { document.getElementById('pc-input').value = 'Is this on my itinerary?'; });
  await page.evaluate(async () => _planSendMessage());
  const body = await aiRequestBody(page);
  assert.match(body.user, /QK7T2M/, 'the booking reference must be in the request body');
  assert.match(body.user, /ATTACHED FILE: flight\.txt/);
  assert.match(body.user, /Is this on my itinerary\?/);
  // And the tray clears, so the same file is not re-sent with the next question.
  const left = await page.evaluate(async () => document.querySelectorAll('.pc-file').length);
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
  assert.equal(await page.evaluate(async () => document.querySelectorAll('.pc-file').length), 1,
    'the same file pasted twice stays one attachment');
  await page.evaluate(async () => document.querySelector('.pc-file-x').click());
  assert.equal(await page.evaluate(async () => document.querySelectorAll('.pc-file').length), 0);
  assert.equal(await page.evaluate(async () => getComputedStyle(document.getElementById('pc-attach')).display), 'none',
    'the empty tray hides itself');
  await page.close();
});

test('a file alone, with no typed question, is still a valid message', async () => {
  const { page } = await openTrip(CHAT_DAY);
  await openChat(page);
  await captureAiRequest(page);
  await attach(page, [{ name: 'ticket.txt', type: 'text/plain', b64: b64('Ref RJ4419 Edinburgh Waverley 09:12') }]);
  await page.evaluate(async () => _planSendMessage());        // input left empty on purpose
  const body = await aiRequestBody(page);
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
  await page.evaluate(async () => openPlanChat());
  await page.waitForSelector('#pc-input', { state: 'attached' });
  await captureAiRequest(page);
  await page.evaluate(() => { document.getElementById('pc-input').value = 'hello'; });
  await page.evaluate(async () => _planSendMessage());
  const body = await aiRequestBody(page);
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
  const txt = await page.evaluate(async () => document.querySelector('.card-endtime').textContent);
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
  await page.evaluate(async () => openEditStopModal(0, 0));
  await page.waitForSelector('#f-audiourl', { state: 'attached' });
  const v = await page.evaluate(async () => document.getElementById('f-audiourl').value);
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

// ===========================================================================
// THE CHANGE LOG (v192). Every mechanism that can alter the itinerary has to
// leave a record, including the two that run without you touching anything:
// the auto-fix gate on save, and the healing pass on load.
// ===========================================================================
test('the History button opens a readable log', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    commit('Moved dinner later on Day 1', () => { state.days[0].stops[1].time = '2:00 PM'; }, WRITE.USER);
  });
  await page.evaluate(async () => openChangeLog());
  const shown = await page.evaluate(() => ({
    open: document.getElementById('trip-recap-modal').classList.contains('open'),
    text: document.getElementById('trip-recap-content').textContent,
  }));
  assert.ok(shown.open, 'the history modal opens');
  assert.match(shown.text, /You edited it/, 'the mechanism is named in plain English');
  assert.match(shown.text, /Moved dinner later on Day 1/, 'and so is the change');
  await page.close();
});

test('the log names the mechanism in plain English, not a code word', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  const text = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    commit('a', () => { state.days[0].stops[0].notes = '1'; }, WRITE.CLOUD);
    commit('b', () => { state.days[0].stops[0].notes = '2'; }, WRITE.AI);
    commit('c', () => { state.days[0].stops[0].notes = '3'; }, WRITE.AUTO);
    openChangeLog();
    return document.getElementById('trip-recap-content').textContent;
  });
  assert.match(text, /Arrived from another device/);
  assert.match(text, /Ask AI applied changes/);
  assert.match(text, /Auto-fixed to make the day work/);
  assert.ok(!/auto-fix<|WRITE\./.test(text), 'no internal identifiers leak into the UI');
  await page.close();
});

test('healing on load records what it rewrote', async () => {
  // Times running backwards on a non-overnight day is the signature that makes
  // _healEarlyDays recompute the whole day — a change nobody asked for.
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Late start', type: 'hike', time: '2:00 PM', endTime: '3:00 PM', lat: 51.5, lng: -0.12 },
      { name: 'Earlier somehow', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 51.51, lng: -0.13 },
    ] },
  ], { day: null });
  // The heal runs during load, so the evidence is in the log by the time the
  // page is ready — not in a second call, which would find nothing left to do.
  const out = await page.evaluate(() => ({
    order: state.days[0].stops.map((s) => s.name),
    log: _loadChangeLog(),
  }));
  const heal = out.log.filter((e) => e.source === 'heal');
  assert.ok(heal.length > 0,
    'the load-time rewrite must be in the history, got '
      + JSON.stringify(out.log.map((e) => e.source + ':' + e.desc)));
  assert.match(heal[0].desc, /On opening/);
  // Whichever pass fired, it must NAME itself rather than leaving a bare entry.
  assert.match(heal[0].desc, /recomputed|reordered|repaired|rewrote/,
    'the pass must say what it did, got ' + heal[0].desc);
  await page.close();
});

test('a refused change is recorded too, so a rejection is never silent', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  const text = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    commit('corrupt it', () => { state.days[0].stops = null; }, WRITE.USER);
    openChangeLog();
    return document.getElementById('trip-recap-content').textContent;
  });
  assert.match(text, /Refused:/, 'the refusal appears in the history');
  await page.close();
});

test('the log survives a reload and is capped', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    for (let i = 0; i < CHANGELOG_MAX + 40; i++) _recordChange({ source: WRITE.USER, desc: 'edit ' + i });
  });
  const after = await page.evaluate(() => {
    _changeLog = null;                       // force a re-read from storage
    const log = _loadChangeLog();
    return { n: log.length, first: log[0].desc, last: log[log.length - 1].desc };
  });
  assert.equal(after.n, 300, 'the log is capped, got ' + after.n);
  assert.equal(after.last, 'edit ' + (300 + 40 - 1), 'the newest entries are the ones kept');
  assert.equal(after.first, 'edit 40', 'and the oldest are dropped');
  await page.close();
});

// ===========================================================================
// CANONICAL TIME MODEL (v193). A stop's time is a wall clock plus the IANA zone
// it is read in; the instant is derived. Durations are two instants subtracted,
// which is why the midnight-wrap and date-line special cases can go.
// ===========================================================================
async function withZones(page, pairs) {
  await page.evaluate((ps) => { ps.forEach(([la, ln, tz]) => { tzData[tzKey(la, ln)] = { tz }; }); }, pairs);
}

test('a stop carries a dated, zoned start and end after loading', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Flight MCO to LGW', type: 'flight', time: '6:55 PM', endTime: '8:45 AM',
        startDate: '2026-08-04', tz: 'America/New_York', endTz: 'Europe/London',
        lat: 28.4312, lng: -81.3081 },
    ] },
  ]);
  const s = await page.evaluate(() => {
    const st = state.days[0].stops[0];
    return { start: _stopStart(st, '2026-08-04'), end: _stopEnd(st, '2026-08-04') };
  });
  assert.equal(s.start.local, '2026-08-04T18:55');
  assert.equal(s.start.zone, 'America/New_York');
  assert.equal(s.end.local, '2026-08-05T08:45', 'the end rolls onto the next day by itself');
  assert.equal(s.end.zone, 'Europe/London');
  await page.close();
});

test('a transatlantic flight duration is the real elapsed time', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Flight MCO to LGW', type: 'flight', time: '6:55 PM', endTime: '8:45 AM',
        startDate: '2026-08-04', tz: 'America/New_York', endTz: 'Europe/London',
        lat: 28.4312, lng: -81.3081 },
    ] },
  ]);
  const out = await page.evaluate(() => ({
    mins: _stopDurationMins(state.days[0].stops[0], '2026-08-04'),
    text: _displayDuration(state.days[0].stops[0], '2026-08-04'),
  }));
  // 18:55 EDT is 22:55 UTC; 08:45 BST is 07:45 UTC the next day. 8h 50min.
  assert.equal(out.mins, 530, 'got ' + out.mins + ' minutes');
  assert.equal(out.text, '8h 50min');
  await page.close();
});

test('crossing the date line does not produce a 37-hour flight', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      // Sydney to Los Angeles ARRIVES at an earlier clock time on the SAME date.
      { name: 'SYD to LAX', type: 'flight', time: '11:00 AM', endTime: '6:30 AM',
        startDate: '2026-08-04', endDate: '2026-08-04',
        tz: 'Australia/Sydney', endTz: 'America/Los_Angeles', lat: -33.94, lng: 151.18 },
    ] },
  ]);
  const mins = await page.evaluate(async () => _stopDurationMins(state.days[0].stops[0], '2026-08-04'));
  assert.ok(mins > 700 && mins < 900, 'about 13 hours, got ' + mins + ' minutes');
  await page.close();
});

test('a same-zone stop is unaffected by any of this', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:30 PM',
        startDate: '2026-08-05', tz: 'Europe/London', endTz: 'Europe/London',
        lat: 51.5194, lng: -0.127 },
    ] },
  ]);
  const out = await page.evaluate(async () => _displayDuration(state.days[0].stops[0], '2026-08-05'));
  assert.equal(out, '2h 30min');
  await page.close();
});

test('an unresolvable zone gives no instant rather than a wrong one', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Nowhere', type: 'hike', time: '10:00 AM', endTime: '11:30 AM',
        startDate: '2026-08-05', tz: 'ZZZ', endTz: 'ZZZ' },
    ] },
  ]);
  const out = await page.evaluate(() => ({
    inst: _stopStartInstant(state.days[0].stops[0], '2026-08-05'),
    // The display still has to say something sensible.
    text: _displayDuration(state.days[0].stops[0], '2026-08-05'),
  }));
  assert.equal(out.inst, null, 'no instant is claimed');
  assert.equal(out.text, '1h 30min', 'but the wall-clock fallback still answers');
  await page.close();
});

test('editing a time the ordinary way is NOT reverted by the canonical copy', async () => {
  // The canonical pair is DERIVED. If it won instead, all 67 places that write
  // s.time directly would have their edits silently undone.
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    _markCommitted();
    commit('retime lunch', () => { state.days[0].stops[1].time = '2:00 PM'; }, WRITE.USER);
    const s = state.days[0].stops[1];
    return { time: s.time, canonical: s.start && s.start.local };
  });
  assert.equal(out.time, '2:00 PM', 'the edit stands');
  assert.match(out.canonical, /T14:00$/, 'and the canonical copy followed it, got ' + out.canonical);
  await page.close();
});

test('a stop with only a bare time gains the date it belongs to', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'No date on me', type: 'hike', time: '9:00 AM', endTime: '10:00 AM',
        lat: 51.5, lng: -0.12 },
    ] },
  ]);
  const s = await page.evaluate(() => {
    const st = state.days[0].stops[0];
    return { start: st.start && st.start.local, startDate: st.startDate };
  });
  assert.match(s.start || '', /^\d{4}-\d{2}-\d{2}T09:00$/,
    'the canonical start is dated, got ' + s.start);
  assert.ok(s.startDate, 'and the legacy date field was filled in, got ' + s.startDate);
  await page.close();
});

test('the legacy fields still describe the trip, for a device on an older build', async () => {
  const { page } = await openTrip(WP_DAY);
  const stops = await page.evaluate(() => {
    _markCommitted();
    commit('touch it', () => { state.days[0].stops[0].notes = 'x'; }, WRITE.USER);
    return state.days[0].stops.map((s) => ({ time: s.time, endTime: s.endTime, date: s.startDate }));
  });
  for (const s of stops) {
    assert.match(s.time, /^\d{1,2}:\d{2} (AM|PM)$/, 'time stays readable: ' + s.time);
    assert.match(s.endTime, /^\d{1,2}:\d{2} (AM|PM)$/, 'end time stays readable: ' + s.endTime);
    assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, 'and carries its date: ' + s.date);
  }
  await page.close();
});

// ===========================================================================
// WHERE A STOP BEGINS AND ENDS (v194). _stopFrom / _stopTo are now the only
// interpretation of a stop's geography, so the map, the distance labels and the
// time-zone lookup all agree about where a journey lands.
// ===========================================================================
test('moving a JOURNEY keeps where it is going', async () => {
  const { page } = await openTrip([
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Coffee', type: 'food', time: '8:00 AM', endTime: '8:30 AM', lat: 51.15, lng: -0.18 },
      { name: 'Gatwick Express', type: 'train', time: '9:30 AM', endTime: '10:00 AM',
        lat: 51.1537, lng: -0.1821, destLat: 51.4952, destLng: -0.1441, reservation: 'GX-991' },
    ] },
  ]);
  const after = await page.evaluate(() => {
    moveStop(0, 1, -1);
    const s = state.days[0].stops.find((x) => x.name === 'Gatwick Express');
    return { destLat: s.destLat, destLng: s.destLng, reservation: s.reservation };
  });
  assert.equal(after.destLat, 51.4952, 'a real destination must survive a move');
  assert.equal(after.destLng, -0.1441);
  assert.equal(after.reservation, 'GX-991');
  await page.close();
});

test('a journey ends at its stated destination', async () => {
  const { page } = await openTrip([
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Gatwick Express', type: 'train', time: '9:30 AM', endTime: '10:00 AM',
        lat: 51.1537, lng: -0.1821, destLat: 51.4952, destLng: -0.1441 },
      { name: 'British Museum', type: 'hike', time: '11:00 AM', endTime: '1:00 PM',
        lat: 51.5194, lng: -0.127 },
    ] },
  ]);
  const out = await page.evaluate(() => {
    const s = state.days[0].stops[0];
    return { from: _stopFrom(s), to: _stopTo(s, state.days[0].stops.slice(1)) };
  });
  assert.equal(out.from.lat, 51.1537);
  assert.equal(out.to.lat, 51.4952, 'Victoria, not the museum, got ' + out.to.lat);
  await page.close();
});

test('a journey with no stated destination ends where it delivers you', async () => {
  const { page } = await openTrip([
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Gatwick Express', type: 'train', time: '9:30 AM', endTime: '10:00 AM',
        lat: 51.1537, lng: -0.1821 },
      { name: 'Royal Horseguards', type: 'lodge', time: '10:30 AM', endTime: '11:00 AM',
        lat: 51.5063, lng: -0.1237 },
    ] },
  ]);
  const to = await page.evaluate(async () =>
    _stopTo(state.days[0].stops[0], state.days[0].stops.slice(1)));
  assert.equal(to.lat, 51.5063, 'the next located stop, got ' + to.lat);
  await page.close();
});

test('a place ends where it begins', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.5194, lng: -0.127 },
      { name: 'Dishoom', type: 'food', time: '1:00 PM', endTime: '1:45 PM',
        lat: 51.5115, lng: -0.1265 },
    ] },
  ]);
  const out = await page.evaluate(() => {
    const s = state.days[0].stops[0];
    const to = _stopTo(s, state.days[0].stops.slice(1));
    return { to, from: _stopFrom(s) };
  });
  assert.equal(out.to.lat, out.from.lat, 'a museum does not travel to the restaurant');
  assert.equal(out.to.lng, out.from.lng);
  await page.close();
});

test('a destination on a stop that is not a journey is dropped on write', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.5194, lng: -0.127 },
      { name: 'Dishoom', type: 'food', time: '1:00 PM', endTime: '1:45 PM',
        lat: 51.5115, lng: -0.1265 },
      { name: 'Royal Horseguards', type: 'lodge', time: '8:00 PM', endTime: '9:00 PM',
        lat: 51.5063, lng: -0.1237 },
    ] },
  ]);
  const out = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    commit('give a museum a destination', () => {
      state.days[0].stops[0].destLat = 40.0; state.days[0].stops[0].destLng = -74.0;
    }, WRITE.USER);
    return { destLat: state.days[0].stops[0].destLat, log: _loadChangeLog() };
  });
  assert.equal(out.destLat, undefined, 'the stray destination is removed');
  assert.ok(out.log.some((e) => (e.repaired || []).some((r) => /not a journey/.test(r))),
    'and the repair is recorded, got ' + JSON.stringify(out.log.map((e) => e.repaired)));
  await page.close();
});

test('the end time zone is read at the arrival airport, not the departure one', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'MCO to LGW', type: 'flight', time: '6:55 PM', endTime: '8:45 AM',
        lat: 28.4312, lng: -81.3081, destLat: 51.1537, destLng: -0.1821 },
    ] },
  ]);
  const out = await page.evaluate(() => {
    tzData[tzKey(28.4312, -81.3081)] = { tz: 'America/New_York' };
    tzData[tzKey(51.1537, -0.1821)] = { tz: 'Europe/London' };
    const s = state.days[0].stops[0];
    return { start: _startZone(s), end: _endZone(s) };
  });
  assert.equal(out.start, 'America/New_York');
  assert.equal(out.end, 'Europe/London', 'the far end decides, got ' + out.end);
  await page.close();
});

test('every transit leg on the real trip still draws after the refactor', async () => {
  const trip = JSON.parse(fs.readFileSync(path.join(ROOT, 'trips', 'london-scotland.json'), 'utf8'));
  const { page } = await openTrip(trip.days, { day: 0 });
  const perDay = await page.evaluate(() => state.days.map((d, i) =>
    _transitLegs(d.stops, (state.days[i + 1] || {}).stops).length));
  const total = perDay.reduce((a, b) => a + b, 0);
  // Assert that journeys DRAW, not a count — the seed is the real itinerary now
  // and its mix of flights, trains and driving days changes as the trip is
  // edited. A magic number here just breaks whenever the plan does.
  assert.ok(total >= 5, 'the trip draws its journeys, got ' + JSON.stringify(perDay));
  assert.ok(perDay[0] >= 1, 'including the Day 1 flight, got ' + perDay[0]);
  assert.ok(perDay.filter((n) => n > 0).length >= 3,
    'across several days, got ' + JSON.stringify(perDay));
  await page.close();
});

// ===========================================================================
// v195 — four reports from the live app.
// ===========================================================================

// 1. THE SAME FLIGHT REPORTED TWO DIFFERENT LANDING TIMES. The continuation
// banner used the flight's own endTime; the transit bookend used the NEXT
// STOP's start time and called it "arriving".
const OVERNIGHT = [
  { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
    { name: 'Flight Z0 784 — MCO to LGW', type: 'flight', time: '8:30 PM', endTime: '10:00 AM',
      startDate: '2026-08-04', lat: 28.4312, lng: -81.3081, reservation: 'Z0784' },
  ] },
  { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
    { name: 'Land at London Gatwick', type: 'flight', time: '11:00 AM', endTime: '11:45 AM',
      lat: 51.1537, lng: -0.1821 },
  ] },
];

test('a flight reports ONE landing time, not two', async () => {
  const { page } = await openTrip(OVERNIGHT, { day: 1 });
  const times = await page.evaluate(() => {
    const panel = document.querySelector('.day-panel.active') || document.getElementById('content-area');
    const txt = panel.textContent;
    return { txt, hits: (txt.match(/1[01]:00 AM/g) || []) };
  });
  // 11:00 AM is the NEXT stop's start; it must never be presented as the arrival.
  assert.ok(!/arriv\w*[^.]{0,20}11:00 AM/i.test(times.txt),
    'the next stop\'s start time must not be labelled as the arrival: ' + times.txt.slice(0, 400));
  assert.match(times.txt, /10:00 AM/, 'the flight\'s real end time is what is shown');
  await page.close();
});

test('an overnight flight is shown once, not as two boxes', async () => {
  const { page } = await openTrip(OVERNIGHT, { day: 1 });
  const n = await page.evaluate(() => {
    const panel = document.querySelector('.day-panel.active') || document.getElementById('content-area');
    return {
      bookends: panel.querySelectorAll('.hotel-bookend').length,
      continues: /Continues from Day/i.test(panel.textContent),
      inflight: /In flight/i.test(panel.textContent),
    };
  });
  assert.ok(n.continues, 'the continuation banner describes the leg');
  assert.ok(!n.inflight, 'and the transit bookend must not repeat it');
  await page.close();
});

test('the transit bookend, when it does show, reports the journey\'s own arrival', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      // Ends on the SAME day, so no continuation banner: the bookend is the one
      // that has to be right.
      { name: 'Train to Edinburgh', type: 'train', time: '2:00 PM', endTime: '6:30 PM',
        startDate: '2026-08-04', endDate: '2026-08-04', lat: 53.4808, lng: -2.2426,
        reservation: 'LNER-8891' },
    ] },
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Edinburgh Castle', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 55.9486, lng: -3.1999 },
    ] },
  ], { day: 1 });
  const txt = await page.evaluate(() => {
    const b = document.querySelector('.hotel-bookend');
    return b ? b.textContent : '';
  });
  assert.match(txt, /6:30 PM/, 'the train\'s own arrival, got: ' + txt);
  assert.ok(!/10:00 AM/.test(txt), 'not the next stop\'s start: ' + txt);
  await page.close();
});

// 2. THE BOOKING BELONGS IN EVERY GREEN BOX, not only the hotel ones.
test('a booked journey shows its confirmation in the green box', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Train to Edinburgh', type: 'train', time: '2:00 PM', endTime: '6:30 PM',
        startDate: '2026-08-04', endDate: '2026-08-04', lat: 53.4808, lng: -2.2426,
        reservation: 'LNER-8891' },
    ] },
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Edinburgh Castle', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 55.9486, lng: -3.1999 },
    ] },
  ], { day: 1 });
  const txt = await page.evaluate(() => (document.querySelector('.hotel-bookend') || {}).textContent || '');
  assert.match(txt, /LNER-8891/, 'the confirmation number belongs here too, got: ' + txt);
  await page.close();
});

test('every hotel surface shows the confirmation and the ticket button', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Tower of London', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.5081, lng: -0.0759 },
      { name: 'Royal Horseguards Hotel', type: 'lodge', time: '8:00 PM', endTime: '9:00 PM',
        lat: 51.5063, lng: -0.1237, reservation: '1072991266',
        ticketImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    ] },
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.5194, lng: -0.127 },
    ] },
  ], { day: 0 });
  // The stop card itself.
  const card = await page.evaluate(() => {
    const c = document.getElementById('stop-card-0-1');
    return { txt: c ? c.textContent : '', btn: c ? c.querySelectorAll('.ticket-view-btn').length : 0 };
  });
  assert.match(card.txt, /1072991266/, 'the card shows the number');
  assert.equal(card.btn, 1, 'exactly one ticket button, not zero and not two, got ' + card.btn);
  // And the green bookend on the FOLLOWING day, where you wake up in it.
  await page.evaluate(async () => switchDay(1));
  await page.waitForTimeout(200);
  const bookend = await page.evaluate(() => {
    const b = document.querySelector('.day-panel.active .hotel-bookend');
    return { txt: b ? b.textContent : '', btn: b ? b.querySelectorAll('.ticket-view-btn').length : 0 };
  });
  assert.match(bookend.txt, /1072991266/, 'and so does the next morning\'s box, got: ' + bookend.txt);
  assert.equal(bookend.btn, 1, 'with its own ticket button');
  await page.close();
});

// 3. CHOOSING WHO IS ON A STOP vanished entirely when no travellers were set up.
test('the who-is-joining control is always offered', async () => {
  const { page } = await openTrip(WP_DAY);
  const before = await page.evaluate(() => {
    state.travelers = [];
    openEditStopModal(0, 0);
    const sec = document.getElementById('f-travelers-section');
    return { visible: getComputedStyle(sec).display !== 'none', text: sec.textContent };
  });
  assert.ok(before.visible, 'the section must never hide itself');
  assert.match(before.text, /Add travellers/i, 'it offers a way to set them up, got: ' + before.text);

  const after = await page.evaluate(() => {
    state.travelers = ['Sam', 'Alex', 'Jo'];
    _populateTravelersForm(state.days[0].stops[0]);
    const boxes = Array.from(document.querySelectorAll('#f-travelers-checkboxes input'));
    return { n: boxes.length, values: boxes.map((b) => b.value), checked: boxes.filter((b) => b.checked).length };
  });
  assert.equal(after.n, 3, 'one checkbox per traveller, got ' + after.n);
  assert.deepEqual(after.values, ['Sam', 'Alex', 'Jo']);
  assert.equal(after.checked, 3, 'everyone is on it by default');
  await page.close();
});

test('a stop remembers who was selected', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    state.travelers = ['Sam', 'Alex', 'Jo'];
    _populateTravelersForm({ attendance: ['Sam', 'Jo'] });
    const boxes = Array.from(document.querySelectorAll('#f-travelers-checkboxes input'));
    return boxes.filter((b) => b.checked).map((b) => b.value);
  });
  assert.deepEqual(out, ['Sam', 'Jo'], 'the stored selection is restored, got ' + JSON.stringify(out));
  await page.close();
});

// 4. A YOUTUBE LINK IN THE TOUR FIELD PLAYS WHERE THE PHOTO WOULD BE.
test('a YouTube tour plays in the stop picture slot', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Westminster Abbey', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.4994, lng: -0.1273, audioUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30' },
    ] },
  ]);
  await page.waitForFunction(
    () => !!document.querySelector('#stopimg-0-0 iframe'), null, { timeout: 15000 });
  const out = await page.evaluate(() => {
    const f = document.querySelector('#stopimg-0-0 iframe');
    const card = document.getElementById('stop-card-0-0');
    return { src: f.src, allowFs: f.hasAttribute('allowfullscreen'),
      wrapLoaded: document.getElementById('stopimg-0-0').classList.contains('loaded'),
      audioEls: card ? card.querySelectorAll('audio').length : -1 };
  });
  assert.match(out.src, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/, 'got ' + out.src);
  assert.match(out.src, /start=30/, 'the ?t= timestamp is honoured');
  assert.ok(!/autoplay=1/.test(out.src), 'a page of stops must never start playing by itself');
  assert.ok(out.allowFs, 'fullscreen is allowed');
  assert.ok(out.wrapLoaded, 'the slot opens up for it');
  assert.equal(out.audioEls, 0, 'and no broken <audio> element is added alongside');
  await page.close();
});

test('every YouTube link shape is recognised, and non-YouTube is left alone', async () => {
  const { page } = await openTrip(WP_DAY);
  const ids = await page.evaluate(async () => [
    _youTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    _youTubeId('https://youtu.be/dQw4w9WgXcQ'),
    _youTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'),
    _youTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),
    _youTubeId('https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ'),
    _youTubeId('https://podcasts.ricksteves.com/audio-tours/london.mp3'),
    _youTubeId('javascript:alert(1)'),
    _youTubeId(''),
  ]);
  assert.deepEqual(ids.slice(0, 5), Array(5).fill('dQw4w9WgXcQ'), 'got ' + JSON.stringify(ids));
  assert.deepEqual(ids.slice(5), ['', '', ''], 'an audio file and a javascript: URL are not videos');
  await page.close();
});

test('an ordinary audio tour still gets its player', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Westminster Abbey', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.4994, lng: -0.1273, audioUrl: 'https://example.com/tour.mp3' },
    ] },
  ]);
  await page.waitForFunction(
    () => !!document.querySelector('#stop-card-0-0 audio'), null, { timeout: 15000 });
  const n = await page.evaluate(async () => document.querySelectorAll('#stopimg-0-0 iframe').length);
  assert.equal(n, 0, 'an mp3 must not become a video embed');
  await page.close();
});

// ===========================================================================
// v196 — ONE STRING PER THING.
// Two reports, one shape: the same fact stored in two places, which then drift.
// ===========================================================================

// A. THE TRIP'S NAME. The home page built its cards from trips/manifest.json,
// whose title is baked in at build time. Renaming updated state.title, which the
// manifest can never know about, so the two pages showed different names.
test('renaming a trip changes the name the home page shows', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await page.evaluate(() => { window.prompt = () => 'Scotland 2026 — Final'; renameTripPrompt(); });
  const stored = await page.evaluate(() => ({
    title: state.title,
    saved: JSON.parse(localStorage.getItem('tripState_london-scotland') || '{}').title,
  }));
  assert.equal(stored.title, 'Scotland 2026 — Final');
  assert.equal(stored.saved, 'Scotland 2026 — Final', 'and it is persisted');

  // Now the home page, which builds its card from the manifest.
  const home = await browser.newPage();
  await home.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    if (u.includes('firebaseio.com')) return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    return route.fulfill({ status: 204, body: '' });
  });
  await home.addInitScript(() => {
    localStorage.setItem('tripState_london-scotland', JSON.stringify({ title: 'Scotland 2026 — Final', days: [] }));
  });
  await home.goto(`${origin}/Travel/index.html`, { waitUntil: 'domcontentloaded' });
  await home.waitForFunction(
    () => document.querySelectorAll('.trip-card-title').length > 0, null, { timeout: 15000 });
  const titles = await home.evaluate(() =>
    Array.from(document.querySelectorAll('.trip-card-title')).map((n) => n.textContent));
  assert.ok(titles.includes('Scotland 2026 — Final'),
    'the card must show the live name, got ' + JSON.stringify(titles));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'trips', 'manifest.json'), 'utf8'));
  const baked = manifest.find((t) => t.id === 'london-scotland');
  assert.ok(!titles.includes(baked.title),
    'and not the name baked into the manifest ("' + baked.title + '")');
  await home.close();
  await page.close();
});

test('a trip nobody renamed still shows its manifest name', async () => {
  const home = await browser.newPage();
  await home.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await home.goto(`${origin}/Travel/index.html`, { waitUntil: 'domcontentloaded' });
  await home.waitForFunction(
    () => document.querySelectorAll('.trip-card-title').length > 0, null, { timeout: 15000 });
  const titles = await home.evaluate(() =>
    Array.from(document.querySelectorAll('.trip-card-title')).map((n) => n.textContent));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'trips', 'manifest.json'), 'utf8'));
  assert.ok(titles.includes(manifest[0].title),
    'the fallback still works, got ' + JSON.stringify(titles));
  await home.close();
});

// B. WHO IS ON THE TRIP. The per-stop checkboxes must be exactly the trip list.
test('the people on a stop are exactly the people on the trip', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    state.travelers = ['Sam', 'Alex', 'Jo'];
    // A stop left over from when the list was different.
    state.days[0].stops[0].attendance = ['Sam', 'Dana', 'Kim'];
    _reconcileAttendance();
    _populateTravelersForm(state.days[0].stops[0]);
    const boxes = Array.from(document.querySelectorAll('#f-travelers-checkboxes input'));
    return { offered: boxes.map((b) => b.value),
      checked: boxes.filter((b) => b.checked).map((b) => b.value),
      stored: state.days[0].stops[0].attendance };
  });
  assert.deepEqual(out.offered, ['Sam', 'Alex', 'Jo'],
    'only the trip list is offered, got ' + JSON.stringify(out.offered));
  assert.deepEqual(out.stored, ['Sam'], 'names no longer on the trip are dropped');
  assert.deepEqual(out.checked, ['Sam']);
  await page.close();
});

test('removing someone from the trip removes them from every stop', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    state.travelers = ['Sam', 'Alex', 'Jo'];
    state.days[0].stops[0].attendance = ['Sam', 'Alex'];
    state.days[0].stops[1].attendance = ['Alex'];
    _markCommitted();
    document.getElementById('travelers-input').value = 'Sam\nJo';
    saveTravelers();
    return { people: state.travelers,
      a0: state.days[0].stops[0].attendance, a1: state.days[0].stops[1].attendance };
  });
  assert.deepEqual(out.people, ['Sam', 'Jo']);
  assert.deepEqual(out.a0, ['Sam'], 'Alex is gone from the first stop');
  // The second stop was Alex only; with nobody left it means everybody again.
  assert.equal(out.a1, undefined, 'a stop with nobody left on it means everyone');
  await page.close();
});

test('a stop where everyone is going stores nothing special', async () => {
  const { page } = await openTrip(WP_DAY);
  const stored = await page.evaluate(() => {
    state.travelers = ['Sam', 'Jo'];
    state.days[0].stops[0].attendance = ['Sam', 'Jo'];
    _reconcileAttendance();
    return state.days[0].stops[0].attendance;
  });
  assert.equal(stored, undefined, 'everyone is the default, not a stored list');
  await page.close();
});

test('the wizard answer becomes the trip list when it names people', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    const names = _travelersFromMeta.call(null);
    state._meta = { who: 'Sam, Alex and Jo' };
    const parsed = _travelersFromMeta();
    state._meta = { who: '2 adults, 2 kids' };
    const group = _travelersFromMeta();
    return { parsed, group, names };
  });
  assert.deepEqual(out.parsed, ['Sam', 'Alex', 'Jo'],
    'named people become the trip list, got ' + JSON.stringify(out.parsed));
  assert.deepEqual(out.group, [],
    'a description of a group is not a list of names, got ' + JSON.stringify(out.group));
  await page.close();
});

test('adding someone to the trip includes them on stops that had everyone', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => {
    state.travelers = ['Sam', 'Jo'];
    state.days[0].stops[0].attendance = ['Sam', 'Jo'];   // "everyone", written out
    _reconcileAttendance();
    // Now a third person joins the trip.
    state.travelers = ['Sam', 'Jo', 'Alex'];
    _populateTravelersForm(state.days[0].stops[0]);
    const boxes = Array.from(document.querySelectorAll('#f-travelers-checkboxes input'));
    return boxes.filter((b) => b.checked).map((b) => b.value);
  });
  assert.deepEqual(out, ['Sam', 'Jo', 'Alex'],
    'a stop that had everyone still has everyone, got ' + JSON.stringify(out));
  await page.close();
});

// ===========================================================================
// v197 — NIGHTS. The stat counted LODGE STOP CARDS, so a four-night stay
// entered as a single check-in counted as one, and an 11-day trip reported
// 7 nights. An 11-day trip has 10 nights, by definition.
// ===========================================================================
function tripOfDays(n, extra) {
  return Array.from({ length: n }, (_, i) => ({
    title: 'Day ' + (i + 1), subtitle: 'Day ' + (i + 1),
    stops: (extra && extra[i]) || [
      { name: 'Stop ' + (i + 1), type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.5 + i / 100, lng: -0.12 },
    ],
  }));
}

test('an 11-day trip has 10 nights, not one per hotel booking', async () => {
  // One hotel stop covering a multi-night stay — exactly how it is really entered.
  const days = tripOfDays(11);
  days[1].stops.push({ name: 'Royal Horseguards Hotel', type: 'lodge', time: '8:00 PM',
    endTime: '9:00 PM', lat: 51.5063, lng: -0.1237 });
  const { page } = await openTrip(days, { day: null });
  const out = await page.evaluate(() => ({
    nights: _tripNights(),
    lodgeCards: state.days.reduce((n, d) => n + d.stops.filter((s) => s.type === 'lodge').length, 0),
  }));
  assert.equal(out.nights, 10, '11 days is 10 nights, got ' + out.nights);
  assert.equal(out.lodgeCards, 1, 'and it is not the number of lodging cards, which is ' + out.lodgeCards);
  await page.close();
});

test('the Nights stat on screen shows the real number', async () => {
  const days = tripOfDays(11);
  days[1].stops.push({ name: 'Royal Horseguards Hotel', type: 'lodge', time: '8:00 PM',
    endTime: '9:00 PM', lat: 51.5063, lng: -0.1237 });
  const { page } = await openTrip(days, { day: null });
  await page.waitForFunction(() => !!document.querySelector('.ov-stats'), null, { timeout: 15000 });
  const stats = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ov-stat')).map((s) => ({
      num: s.querySelector('.ov-stat-num').textContent,
      label: s.querySelector('.ov-stat-label').textContent,
    })));
  const nights = stats.find((s) => /nights/i.test(s.label));
  assert.ok(nights, 'the Nights stat exists, got ' + JSON.stringify(stats));
  assert.equal(nights.num, '10', 'it reads 10, got ' + nights.num);
  const days_ = stats.find((s) => /days/i.test(s.label));
  assert.equal(days_.num, '11');
  await page.close();
});

test('a one-day trip has no nights', async () => {
  const { page } = await openTrip(tripOfDays(1), { day: null });
  const n = await page.evaluate(async () => _tripNights());
  assert.equal(n, 0, 'a single day has nowhere to sleep afterwards, got ' + n);
  await page.close();
});

test('a night spent on an overnight flight counts as covered', async () => {
  const days = tripOfDays(3);
  days[0].stops = [{ name: 'Flight MCO to LGW', type: 'flight', time: '8:30 PM', endTime: '10:00 AM',
    startDate: '2026-08-04', endDate: '2026-08-05', lat: 28.4312, lng: -81.3081 }];
  days[1].stops.push({ name: 'Royal Horseguards Hotel', type: 'lodge', time: '8:00 PM',
    endTime: '9:00 PM', lat: 51.5063, lng: -0.1237 });
  const { page } = await openTrip(days, { day: null });
  const out = await page.evaluate(() => ({
    transit: _sleepsInTransit(0),
    nights: _tripNights(),
    covered: _nightsWithSomewhereToSleep(),
  }));
  assert.ok(out.transit, 'the overnight flight is recognised as a night in transit');
  assert.equal(out.nights, 2);
  assert.equal(out.covered, 2, 'both nights are accounted for, got ' + out.covered);
  await page.close();
});

test('nights with nowhere booked are called out', async () => {
  const days = tripOfDays(5);   // 4 nights, no lodging at all
  const { page } = await openTrip(days, { day: null });
  await page.waitForFunction(() => !!document.querySelector('.ov-stats'), null, { timeout: 15000 });
  const out = await page.evaluate(() => ({
    covered: _nightsWithSomewhereToSleep(),
    nights: _tripNights(),
    sub: (document.querySelector('.ov-stat-sub') || {}).textContent || '',
  }));
  assert.equal(out.nights, 4);
  assert.equal(out.covered, 0, 'nothing is booked');
  assert.match(out.sub, /4 with nowhere booked/, 'and the gap is stated, got: ' + out.sub);
  await page.close();
});

test('a fully covered trip shows no warning', async () => {
  const days = tripOfDays(3);
  // A hotel on each of the two nights that need one.
  [0, 1].forEach((i) => days[i].stops.push({ name: 'Hotel ' + i, type: 'lodge',
    time: '8:00 PM', endTime: '9:00 PM', lat: 51.5, lng: -0.12 }));
  const { page } = await openTrip(days, { day: null });
  await page.waitForFunction(() => !!document.querySelector('.ov-stats'), null, { timeout: 15000 });
  const out = await page.evaluate(() => ({
    covered: _nightsWithSomewhereToSleep(), nights: _tripNights(),
    subs: document.querySelectorAll('.ov-stat-sub').length,
  }));
  assert.equal(out.covered, out.nights, 'every night has somewhere to sleep');
  assert.equal(out.subs, 0, 'so nothing is flagged');
  await page.close();
});

// ===========================================================================
// v198 — TRAVEL TIME. The connector read "0.9 mi · 3 min" on a leg labelled
// Walk. 3 minutes is what _travelMins returns for that distance by CAR: a
// second function rewrote the connector after render using its own mode rule,
// which had no 'walk' case and fell through to 'drive'.
// ===========================================================================
test('a walking leg on screen is timed as a walk', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      // 0.013 degrees of latitude apart = 0.9 straight-line miles.
      { name: 'Covent Garden', type: 'hike', time: '10:00 AM', endTime: '11:00 AM',
        lat: 51.5117, lng: -0.1240 },
      { name: 'British Museum', type: 'hike', time: '11:30 AM', endTime: '1:00 PM',
        lat: 51.5247, lng: -0.1240 },
    ] },
  ]);
  await page.waitForFunction(
    () => !!document.querySelector('.leg-connector'), null, { timeout: 15000 });
  const leg = await page.evaluate(() => {
    const c = document.querySelector('.leg-connector');
    return { text: c.textContent.replace(/\s+/g, ' ').trim(),
      pill: (c.querySelector('.leg-mode-pill') || {}).textContent || '' };
  });
  assert.match(leg.pill, /Walk/, 'the leg is a walk, got ' + leg.pill);
  const m = /([\d.]+) mi · (?:(\d+)h ?)?(\d+)?\s*min/.exec(leg.text);
  assert.ok(m, 'the connector states a distance and a time, got: ' + leg.text);
  const miles = parseFloat(m[1]);
  const mins = (m[2] ? +m[2] * 60 : 0) + (m[3] ? +m[3] : 0);
  const mph = miles / (mins / 60);
  assert.ok(mph >= 2 && mph <= 4,
    'that is ' + mph.toFixed(1) + ' mph on foot — ' + leg.text);
  assert.ok(mins >= 15, 'about a mile on foot is not a 3 minute job, got ' + mins + ' min');
  await page.close();
});

test('the same leg by car is quicker than on foot, and both are sane', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => ({
    walk: _travelMins(0.9, 'walk'), drive: _travelMins(0.9, 'drive'),
    walkFar: _travelMins(12, 'walk'), driveFar: _travelMins(12, 'drive'),
  }));
  assert.ok(out.walk > out.drive, 'walking a mile must take longer than driving it');
  assert.ok(out.walkFar > out.driveFar, 'and the same over 12 miles');
  assert.ok(out.walk >= 18 && out.walk <= 28, '0.9 mi on foot ~23 min, got ' + out.walk);
  await page.close();
});

test('the distance shown is the distance actually travelled', async () => {
  const { page } = await openTrip(WP_DAY);
  const out = await page.evaluate(() => ({
    straight: haversine(51.5117, -0.1240, 51.5194, -0.1270),
    route: _routeMiles(haversine(51.5117, -0.1240, 51.5194, -0.1270), 'walk'),
  }));
  assert.ok(out.route > out.straight, 'streets are longer than the crow flies');
  assert.ok(out.route < out.straight * 1.6, 'but not absurdly so');
  await page.close();
});

test('a leg after a train starts where the train ARRIVES', async () => {
  const { page } = await openTrip([
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Gatwick Express', type: 'train', time: '9:30 AM', endTime: '10:00 AM',
        lat: 51.1537, lng: -0.1821, destLat: 51.4952, destLng: -0.1441 },
      { name: 'Royal Horseguards', type: 'lodge', time: '10:30 AM', endTime: '11:00 AM',
        lat: 51.5063, lng: -0.1237 },
    ] },
  ]);
  await page.waitForFunction(
    () => !!document.querySelector('.leg-connector'), null, { timeout: 15000 });
  const text = await page.evaluate(async () =>
    document.querySelector('.leg-connector').textContent.replace(/\s+/g, ' ').trim());
  const miles = parseFloat(/([\d.]+) mi/.exec(text)[1]);
  // Victoria to Whitehall is about a mile. Gatwick to Whitehall is about 25.
  assert.ok(miles < 5,
    'the leg must run from Victoria, not from Gatwick, got ' + miles + ' mi — ' + text);
  await page.close();
});

// ===========================================================================
// v199 — THE GRADE MUST RESPECT OPENING HOURS. It suggested the Tate Modern
// for an evening walk: the grader was never told hours mattered, was never
// given the weekday, and its answer was never checked.
// ===========================================================================
test('the grader is told the weekday and each stop\'s hours', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:30 PM',
        lat: 51.5194, lng: -0.127, dayHours: '10:00 AM - 5:00 PM' },
      { name: 'Evening walk — South Bank', type: 'hike', time: '7:30 PM', endTime: '9:00 PM',
        lat: 51.5074, lng: -0.1167 },
    ] },
  ], { day: null });
  await captureAiRequest(page);
  await page.evaluate(async () => gradeItinerary());
  const body = await aiRequestBody(page);
  assert.match(body.system, /OPENING HOURS ARE A HARD CONSTRAINT/,
    'hours must be a stated criterion, not an afterthought');
  assert.match(body.system, /suggested_time/, 'and the answer must carry a time that can be checked');
  assert.match(body.user, /open: 10:00 AM - 5:00 PM/,
    'the hours the app already knows must be sent, got: ' + body.user.slice(0, 400));
  assert.match(body.user, /Wednesday|2026-08-05/,
    'and the weekday, because many places shut on a Monday');
  assert.match(body.user, /10:00 AM-12:30 PM/, 'with the full window, not just the start');
  await page.close();
});

test('a suggestion that would be closed never reaches the screen', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Evening walk — South Bank', type: 'hike', time: '7:30 PM', endTime: '9:00 PM',
        lat: 51.5074, lng: -0.1167 },
    ] },
  ], { day: null });
  // Answer with exactly the bug that was reported.
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'B', rationale: 'Good bones.' },
      suggested_additions: [
        { name: 'Tate Modern', type: 'hike', reason: 'Iconic', suggested_day: 1,
          suggested_time: '8:00 PM', hours: '10:00 AM - 6:00 PM', fits_near: 'Evening walk — South Bank' },
        { name: 'Borough Market night walk', type: 'hike', reason: 'Lively after dark', suggested_day: 1,
          suggested_time: '8:00 PM', hours: 'Open 24 hours', fits_near: 'Evening walk — South Bank' },
      ],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /Consider Adding|Discarded/.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  // Read the SECTIONS, not the whole blob: "Consider Adding" appears before
  // "Discarded" in the text, so a naive regex spans both and always matches.
  const sections = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ai-grader-content .ai-section')).map((s) => ({
      hdr: (s.querySelector('.ai-section-hdr') || {}).textContent || '',
      body: Array.from(s.querySelectorAll('.ai-item')).map((i) => i.textContent).join(' | '),
    })));
  const adding = sections.find((s) => /Consider Adding/.test(s.hdr));
  const dropped = sections.find((s) => /Discarded/.test(s.hdr));
  assert.ok(adding, 'there is still a suggestions section');
  assert.ok(!/Tate Modern/.test(adding.body),
    'the closed gallery must not be offered: ' + adding.body);
  assert.match(adding.body, /Borough Market night walk/, 'the one that is open still is');
  assert.ok(dropped, 'and the user is told something was dropped');
  assert.match(dropped.body, /Tate Modern/, 'by name');
  assert.match(dropped.body, /10:00 AM - 6:00 PM/, 'with the hours that ruled it out');
  await page.close();
});

test('a stop scheduled after closing is flagged even if the model missed it', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Tate Modern', type: 'hike', time: '8:00 PM', endTime: '9:30 PM',
        lat: 51.5076, lng: -0.0994, dayHours: '10:00 AM - 6:00 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Nothing wrong here.' },
      timing_conflicts: [],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /Timing Issues/.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const txt = await page.evaluate(async () => document.getElementById('ai-grader-content').textContent);
  assert.match(txt, /Tate Modern/, 'the app found it itself: ' + txt);
  assert.match(txt, /10:00 AM - 6:00 PM/, 'and says which hours it breaks');
  await page.close();
});

test('a suggestion shows the time and hours it is claiming', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'B', rationale: 'x' },
      suggested_additions: [{ name: 'Sir John Soane\'s Museum', type: 'hike', reason: 'Free and extraordinary',
        suggested_day: 1, suggested_time: '11:00 AM', hours: '10:00 AM - 5:00 PM', fits_near: 'British Museum' }],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /Soane/.test(document.getElementById('ai-grader-content').textContent), null, { timeout: 20000 });
  const txt = await page.evaluate(async () => document.getElementById('ai-grader-content').textContent);
  assert.match(txt, /11:00 AM/, 'the proposed time is shown so it can be judged');
  assert.match(txt, /10:00 AM - 5:00 PM/, 'and the hours it claims');
  await page.close();
});

// ===========================================================================
// v200 — CAN AN A BE EARNED? The first version of the hours check capped the
// grade at C for ANY stop outside its hours, and its conflict list contained
// false positives (leaving exactly at closing time; arriving two minutes
// early). No real itinerary could reach an A.
// ===========================================================================
test('a clean itinerary can score an A', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:30 PM',
        lat: 51.5194, lng: -0.127, dayHours: '10:00 AM - 5:00 PM' },
      { name: 'Bettys', type: 'food', time: '8:30 PM', endTime: '9:00 PM',
        lat: 51.51, lng: -0.13, dayHours: '9:00 AM - 9:00 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Exceptional.' },
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /holding the grade back/i.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const out = await page.evaluate(() => ({
    letter: document.querySelector('#ai-grader-content .ai-grade-letter').textContent.trim(),
    txt: document.getElementById('ai-grader-content').textContent,
  }));
  assert.equal(out.letter, 'A', 'an A must be reachable, got ' + out.letter);
  assert.match(out.txt, /not capped/, 'and the app says so plainly');
  await page.close();
});

test('a hard conflict caps the letter and says what to fix', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Tate Modern', type: 'hike', time: '8:00 PM', endTime: '9:30 PM',
        lat: 51.5076, lng: -0.0994, dayHours: '10:00 AM - 6:00 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Flawless.' },
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /holding the grade back/i.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const out = await page.evaluate(() => ({
    letter: document.querySelector('#ai-grader-content .ai-grade-letter').textContent.trim(),
    txt: document.getElementById('ai-grader-content').textContent,
  }));
  assert.equal(out.letter, 'C+', 'the only stop being impossible is the whole trip, got ' + out.letter);
  assert.match(out.txt, /Tate Modern/, 'it names what to fix');
  assert.match(out.txt, /1 of 1 stops/, 'and shows it in proportion to the trip');
  await page.close();
});

test('a two-minute early arrival is shown as minor and does not cap', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Patty & Bun', type: 'food', time: '11:58 AM', endTime: '12:45 PM',
        lat: 51.515, lng: -0.148, dayHours: '12:00 PM - 10:00 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A-', rationale: 'Strong.' },
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /holding the grade back/i.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const out = await page.evaluate(() => ({
    letter: document.querySelector('#ai-grader-content .ai-grade-letter').textContent.trim(),
    txt: document.getElementById('ai-grader-content').textContent,
  }));
  assert.equal(out.letter, 'A-', 'a short wait outside the door is not a downgrade');
  assert.match(out.txt, /minor/i, 'it is still mentioned, marked minor');
  assert.match(out.txt, /not capped/);
  await page.close();
});


// 85 stops spread over 17 days, the shape of a real trip. Put on ONE day they
// are re-timed by the auto-fix gate, which moved the fixture's own stop past
// closing and made the test measure the wrong thing.
function bigTrip({ day, at, stop }) {
  const days = Array.from({ length: 17 }, (_, di) => ({
    title: 'Day ' + (di + 1), subtitle: 'Day ' + (di + 1),
    stops: Array.from({ length: 5 }, (_, si) => ({
      name: 'Stop ' + (di * 5 + si + 1), type: 'hike',
      time: (9 + si) + ':00 AM', endTime: (9 + si) + ':45 AM',
      lat: 51.5 + (di * 5 + si) / 1000, lng: -0.12,
    })),
  }));
  days[day].stops[at] = stop;
  return days;
}

// ===========================================================================
// v201 — PROPORTION. One 31-minute overrun on one stop out of 85 took an A to
// a B+. Two errors: a visit that runs past closing was classed as impossible,
// and the cap ignored how big the trip was.
// ===========================================================================
test('one overrun out of many stops does not cost the A', async () => {
  // 85 stops, one of which runs past closing — exactly the reported case.
  const { page } = await openTrip(bigTrip({ day: 5, at: 2,
    stop: { name: "King's College Chapel", type: 'hike', time: '4:03 PM', endTime: '5:01 PM',
      lat: 52.2045, lng: 0.1166, dayHours: '9:30 AM - 4:30 PM' } }), { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Impressively constructed.' },
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /holding the grade back/i.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const out = await page.evaluate(() => ({
    letter: document.querySelector('#ai-grader-content .ai-grade-letter').textContent.trim(),
    txt: document.getElementById('ai-grader-content').textContent,
  }));
  assert.equal(out.letter, 'A', 'an A must survive one half-hour adjustment, got ' + out.letter);
  assert.match(out.txt, /Nothing\./, 'nothing is holding it back');
  assert.match(out.txt, /run.? past closing/, 'the overrun is still reported');
  assert.match(out.txt, /King's College Chapel/, 'by name');
  assert.match(out.txt, /Ends at closing/, 'labelled as an adjustment, not a defect');
  await page.close();
});

test('one genuinely impossible stop out of many costs only a half step', async () => {
  const { page } = await openTrip(bigTrip({ day: 3, at: 4,
    stop: { name: 'Tate Modern', type: 'hike', time: '8:00 PM', endTime: '9:30 PM',
      lat: 51.5076, lng: -0.0994, dayHours: '10:00 AM - 6:00 PM' } }), { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Strong.' },
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /holding the grade back/i.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const out = await page.evaluate(() => ({
    letter: document.querySelector('#ai-grader-content .ai-grade-letter').textContent.trim(),
    txt: document.getElementById('ai-grader-content').textContent,
  }));
  assert.equal(out.letter, 'A-', 'a real defect costs something, but not a letter, got ' + out.letter);
  assert.match(out.txt, /1 of 85 stops/, 'shown in proportion');
  assert.match(out.txt, /Must move/, 'and marked as the kind of problem it is');
  await page.close();
});

// ===========================================================================
// v202 — LABELS MUST MEAN SOMETHING. Five notes were stamped "MUST MOVE" whose
// own text read "not a hard conflict" and "tight but workable": conflicts the
// REVIEW supplies carry no severity, and the renderer defaulted them to blocked.
// ===========================================================================
test('a review note without a severity is not stamped MUST MOVE', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Thu, Aug 13, 2026', stops: [
      { name: 'National Gallery', type: 'hike', time: '4:36 PM', endTime: '5:45 PM',
        lat: 51.5089, lng: -0.1283, dayHours: '10:00 AM - 6:00 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Strong.' },
      timing_conflicts: [{ day: 1, stop_name: 'National Gallery',
        issue: 'Tight but workable for a highlights run. Not a hard conflict.' }],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /holding the grade back/i.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const out = await page.evaluate(() => ({
    letter: document.querySelector('#ai-grader-content .ai-grade-letter').textContent.trim(),
    txt: document.getElementById('ai-grader-content').textContent,
  }));
  assert.ok(!/Must move/i.test(out.txt),
    'a note saying "not a hard conflict" must not be labelled Must move: ' + out.txt);
  // v206 goes further than v202 did: a note with nothing behind it is not shown
  // at all, rather than shown as a watch item.
  assert.ok(!/Tight but workable/.test(out.txt),
    'and an unproven note is not shown at all: ' + out.txt);
  assert.match(out.txt, /Not shown — nothing to check/, 'but the user is told it was dropped');
  assert.equal(out.letter, 'A', 'and it does not cap the grade, got ' + out.letter);
  await page.close();
});

test('the app\'s OWN finding is still labelled Must move when it truly is', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Tate Modern', type: 'hike', time: '8:00 PM', endTime: '9:30 PM',
        lat: 51.5076, lng: -0.0994, dayHours: '10:00 AM - 6:00 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Flawless.' }, timing_conflicts: [],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /Timing Issues/.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const txt = await page.evaluate(async () => document.getElementById('ai-grader-content').textContent);
  assert.match(txt, /Must move/, 'arriving two hours after closing really is one');
  await page.close();
});

test('a visit is told to run TO closing, never to end early', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: "King's College Chapel", type: 'hike', time: '4:03 PM', endTime: '5:01 PM',
        lat: 52.2045, lng: 0.1166, dayHours: '9:30 AM - 4:30 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Strong.' }, timing_conflicts: [],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /Timing Issues/.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const txt = await page.evaluate(async () => document.getElementById('ai-grader-content').textContent);
  assert.match(txt, /Ends at closing/, 'labelled for what it is');
  assert.match(txt, /Stay to closing/, 'and the advice is to use the whole visit: ' + txt);
  assert.ok(!/leave earlier/i.test(txt), 'never told to cut the visit short');
  await page.close();
});

test('the grader is instructed that closing time is a target, not a hazard', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await captureAiRequest(page);
  await page.evaluate(async () => gradeItinerary());
  const body = await aiRequestBody(page);
  assert.match(body.system, /STAYING UNTIL A PLACE CLOSES IS THE POINT/);
  assert.match(body.system, /NEVER advise leaving early/);
  assert.match(body.system, /LAST ADMISSION only matters if you ARRIVE after it/);
  assert.match(body.system, /severity/, 'and every conflict must declare how serious it is');
  await page.close();
});

test('a swap that replaces a stop with itself is not shown as a swap', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Strong.' },
      suggested_swaps: [{ remove: 'National Gallery', day: 10,
        add: 'National Gallery — enter by 4:36 PM, target the key rooms only',
        reason: 'Already in the plan; this is a pacing note, not a true swap.' }],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /National Gallery/.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const sections = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ai-grader-content .ai-section')).map((s) => ({
      hdr: (s.querySelector('.ai-section-hdr') || {}).textContent || '',
      body: Array.from(s.querySelectorAll('.ai-item')).map((i) => i.textContent).join(' | '),
    })));
  const swaps = sections.find((s) => /Swapping/.test(s.hdr));
  const pacing = sections.find((s) => /Pacing/.test(s.hdr));
  assert.ok(!swaps, 'there is no swap to show, got ' + JSON.stringify(swaps));
  assert.ok(pacing && /National Gallery/.test(pacing.body),
    'but what it said is kept as a pacing note: ' + JSON.stringify(pacing));
  await page.close();
});

// ===========================================================================
// v203 — EVERY GAP BETWEEN TWO STOPS REPORTS A DISTANCE AND A TIME. legLabel
// returned an empty string in three cases (missing coordinate, under 0.05 mi,
// and any leg into a drive), so connectors showed a bare mode pill with no
// numbers — and "nothing to travel" was indistinguishable from "unknown".
// ===========================================================================
async function legTexts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.day-panel.active .leg-connector'))
      .map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
}

test('every leg in a day reports something, with no silent gaps', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Hotel', type: 'lodge', time: '8:00 AM', endTime: '8:30 AM', lat: 51.5063, lng: -0.1237 },
      { name: 'Coffee next door', type: 'food', time: '8:35 AM', endTime: '9:00 AM',
        lat: 51.50631, lng: -0.12371 },                       // metres away
      { name: 'No location yet', type: 'hike', time: '9:30 AM', endTime: '10:00 AM' },
      { name: 'Drive to Windsor', type: 'drive', time: '10:15 AM', endTime: '11:15 AM',
        lat: 51.5074, lng: -0.1278 },
      { name: 'Windsor Castle', type: 'hike', time: '11:30 AM', endTime: '1:30 PM',
        lat: 51.4839, lng: -0.6044 },
    ] },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('.day-panel.active .leg-connector').length >= 4,
    null, { timeout: 15000 });
  const legs = await legTexts(page);
  // Four gaps between the five stops, plus the trailing leg to tonight's hotel.
  assert.ok(legs.length >= 4, 'one connector per gap, got ' + legs.length);
  for (const [i, t] of legs.entries()) {
    assert.ok(/mi ·|Same place|Distance unknown/.test(t),
      'leg ' + (i + 1) + ' says nothing about the journey: "' + t + '"');
  }
  await page.close();
});

test('a stop a few metres away says so, rather than nothing', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Hotel', type: 'lodge', time: '8:00 AM', endTime: '8:30 AM', lat: 51.5063, lng: -0.1237 },
      { name: 'Hotel restaurant', type: 'food', time: '8:35 AM', endTime: '9:00 AM',
        lat: 51.50631, lng: -0.12371 },
    ] },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('.day-panel.active .leg-connector').length >= 1,
    null, { timeout: 15000 });
  const legs = await legTexts(page);
  assert.match(legs[0], /Same place · no travel/, 'got: ' + legs[0]);
  await page.close();
});

test('a stop with no coordinates says the distance is unknown', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
        lat: 51.5194, lng: -0.127 },
      { name: 'Somewhere I have not pinned', type: 'food', time: '1:00 PM', endTime: '2:00 PM' },
    ] },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('.day-panel.active .leg-connector').length >= 1,
    null, { timeout: 15000 });
  const legs = await legTexts(page);
  assert.match(legs[0], /Distance unknown/, 'got: ' + legs[0]);
  assert.ok(!/Same place/.test(legs[0]), 'unknown must not read as "no travel"');
  await page.close();
});

test('the leg into a drive stop is reported, not skipped', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Hotel', type: 'lodge', time: '8:00 AM', endTime: '8:30 AM', lat: 51.5063, lng: -0.1237 },
      { name: 'Drive to Windsor', type: 'drive', time: '9:00 AM', endTime: '10:00 AM',
        lat: 51.4600, lng: -0.3000 },
    ] },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('.day-panel.active .leg-connector').length >= 1,
    null, { timeout: 15000 });
  const legs = await legTexts(page);
  assert.match(legs[0], /mi ·/, 'the run to where the drive starts, got: ' + legs[0]);
  await page.close();
});

test('the real trip has no connector without a distance or a reason', async () => {
  const trip = JSON.parse(fs.readFileSync(path.join(ROOT, 'trips', 'london-scotland.json'), 'utf8'));
  const { page } = await openTrip(trip.days, { day: 0 });
  const bad = [];
  for (let d = 0; d < trip.days.length; d++) {
    await page.evaluate((i) => switchDay(i), d);
    await page.waitForTimeout(120);
    const legs = await legTexts(page);
    legs.forEach((t, i) => {
      if (!/mi ·|Same place|Distance unknown/.test(t)) bad.push('Day ' + (d + 1) + ' leg ' + (i + 1) + ': "' + t + '"');
    });
  }
  assert.deepEqual(bad, [], 'every leg on the real trip must report: ' + bad.join(' | '));
  await page.close();
});

// ===========================================================================
// v204 — APPLYING AN AI ALTERNATE. Reported from a real card: the drive leg
// before "Green Welly Stop Restaurant" showed a mode pill and no distance, and
// the note read 'AI Suggested Alternate: Originally "..." | AI Suggested
// Alternate: Originally "..." | ...'. Both come from confirmApplyAlternate.
// ===========================================================================
test('a swapped stop is re-located, so its leg has a distance again', async () => {
  const { page } = await openTrip([
    { title: 'Day 7', subtitle: 'Mon, Aug 10, 2026', stops: [
      { name: 'Stirling Castle', type: 'hike', time: '9:30 AM', endTime: '10:30 AM',
        lat: 56.1239, lng: -3.9478 },
      { name: 'The Real Food Cafe', type: 'food', time: '10:45 AM', endTime: '11:05 AM',
        lat: 56.4361, lng: -4.7086, notes: 'Quick bite on the A82.' },
    ] },
  ]);
  // Stand in for the geocoder the sandbox cannot reach.
  await page.evaluate(() => {
    window.fetch = async (u) => {
      if (String(u).includes('nominatim')) {
        return { ok: true, json: async () => ([{ lat: '56.4361', lon: '-4.7086',
          display_name: 'Green Welly Stop, Tyndrum' }]) };
      }
      return { ok: true, json: async () => ({}) };
    };
  });
  await page.evaluate(() => { _altResults = [{ name: 'Green Welly Stop Restaurant' }]; confirmApplyAlternate(0, 1, 0); });
  await page.waitForFunction(
    () => { const s = state.days[0].stops[1]; return s.name === 'Green Welly Stop Restaurant' && s.lat; },
    null, { timeout: 15000 });
  const out = await page.evaluate(() => {
    const s = state.days[0].stops[1];
    return { name: s.name, lat: s.lat, needsPin: s.needsPin, notes: s.notes };
  });
  assert.equal(out.name, 'Green Welly Stop Restaurant');
  assert.ok(out.lat, 'the swapped stop has a location again, got ' + out.lat);
  assert.equal(out.needsPin, undefined, 'and is no longer marked as needing a pin');
  const legs = await legTexts(page);
  assert.ok(legs.some((t) => /mi ·/.test(t)),
    'the drive before it reports a distance again, got ' + JSON.stringify(legs));
  await page.close();
});

test('the alternate note does not grow each time you swap', async () => {
  const { page } = await openTrip([
    { title: 'Day 7', subtitle: 'Mon, Aug 10, 2026', stops: [
      { name: 'Stirling Castle', type: 'hike', time: '9:30 AM', endTime: '10:30 AM',
        lat: 56.1239, lng: -3.9478 },
      { name: 'The Real Food Cafe', type: 'food', time: '10:45 AM', endTime: '11:05 AM',
        lat: 56.4361, lng: -4.7086, notes: 'Quick bite on the A82.' },
    ] },
  ]);
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ([]) });   // no geocode
  });
  const notes = await page.evaluate(async () => {
    _altResults = [{ name: 'Lunch — quick bite (Tyndrum)' }];
    confirmApplyAlternate(0, 1, 0);
    _altResults = [{ name: 'Green Welly Stop Restaurant' }];
    confirmApplyAlternate(0, 1, 0);
    return state.days[0].stops[1].notes;
  });
  assert.equal((notes.match(/AI Suggested Alternate/g) || []).length, 1,
    'one prefix, however many swaps: ' + notes);
  assert.match(notes, /Originally "The Real Food Cafe"/, 'naming the true original: ' + notes);
  assert.match(notes, /Quick bite on the A82/, 'and keeping the real note');
  await page.close();
});

test('a stop left with no location says so, in place of Fix pin', async () => {
  const { page } = await openTrip([
    { title: 'Day 7', subtitle: 'Mon, Aug 10, 2026', stops: [
      { name: 'Stirling Castle', type: 'hike', time: '9:30 AM', endTime: '10:30 AM',
        lat: 56.1239, lng: -3.9478 },
      { name: 'The Real Food Cafe', type: 'food', time: '10:45 AM', endTime: '11:05 AM',
        lat: 56.4361, lng: -4.7086 },
    ] },
  ]);
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ([]) });   // geocode finds nothing
    _altResults = [{ name: 'Somewhere Unfindable' }];
    confirmApplyAlternate(0, 1, 0);
  });
  await page.waitForFunction(
    () => state.days[0].stops[1].name === 'Somewhere Unfindable', null, { timeout: 15000 });
  const out = await page.evaluate(() => {
    const card = document.getElementById('stop-card-0-1');
    return { needsPin: state.days[0].stops[1].needsPin,
      btn: (card.querySelector('.map-link-alert') || {}).textContent || '',
      any: card.textContent };
  });
  assert.ok(out.needsPin, 'the stop is marked as having no location');
  assert.match(out.btn, /Set location/, 'and the card asks for one: ' + out.any.slice(0, 200));
  const legs = await legTexts(page);
  assert.ok(legs.some((t) => /Distance unknown/.test(t)),
    'the leg says why it has no number, got ' + JSON.stringify(legs));
  await page.close();
});

// ===========================================================================
// v205 — RAIL SPEED. Reported from Day 9: the connector read "17 mi · 53 min"
// for Ely to Cambridge, a journey the itinerary itself schedules in 31 minutes
// and which takes about 17 minutes on the train.
// ===========================================================================
test('the Ely to Cambridge leg is not an hour', async () => {
  const { page } = await openTrip([
    { title: 'Day 9', subtitle: 'Wed, Aug 12, 2026', stops: [
      { name: 'Ely Cathedral', type: 'hike', time: '2:12 PM', endTime: '2:59 PM',
        lat: 52.3993, lng: 0.2624 },
      { name: "King's College Chapel & The Backs", type: 'hike', time: '3:30 PM', endTime: '4:28 PM',
        lat: 52.2045, lng: 0.1166, transitMode: 'train' },
    ] },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('.day-panel.active .leg-connector').length >= 1,
    null, { timeout: 15000 });
  const legs = await legTexts(page);
  const m = /([\d.]+) mi · (?:(\d+)h ?)?(\d+)?\s*min/.exec(legs[0]);
  assert.ok(m, 'the leg reports a distance and a time, got: ' + legs[0]);
  const mins = (m[2] ? +m[2] * 60 : 0) + (m[3] ? +m[3] : 0);
  // The plan allows 31 minutes; the estimate must be in the same world.
  assert.ok(mins >= 20 && mins <= 40,
    'about half an hour door to door, got ' + mins + ' min — ' + legs[0]);
  await page.close();
});

test('the estimate agrees with what the itinerary itself allows', async () => {
  const { page } = await openTrip([
    { title: 'Day 9', subtitle: 'Wed, Aug 12, 2026', stops: [
      { name: 'Ely Cathedral', type: 'hike', time: '2:12 PM', endTime: '2:59 PM',
        lat: 52.3993, lng: 0.2624 },
      { name: "King's College Chapel & The Backs", type: 'hike', time: '3:30 PM', endTime: '4:28 PM',
        lat: 52.2045, lng: 0.1166, transitMode: 'train' },
    ] },
  ]);
  const out = await page.evaluate(() => {
    const [a, b] = state.days[0].stops;
    return { planned: _parseTimeMins(b.time) - _parseTimeMins(a.endTime),
      estimated: _legTravelMins(a, b) };
  });
  // Read the gap the app actually holds rather than assuming it: the load-time
  // heal is entitled to nudge a time, and the point here is that the ESTIMATE
  // agrees with the plan, not what the plan happens to be to the minute.
  assert.ok(out.planned >= 28 && out.planned <= 35,
    'the plan allows about half an hour, got ' + out.planned);
  assert.ok(Math.abs(out.estimated - out.planned) <= 12,
    'the estimate must be close to it, got ' + out.estimated + ' vs ' + out.planned);
  await page.close();
});

// ===========================================================================
// v206 — "WORTH CHECKING" WAS NOISE. Every one of those notes was about
// opening times the app had not actually checked, and several were about stops
// with tickets already bought for that date and time.
// ===========================================================================
test('speculative timing notes never reach the screen', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 12, 2026', stops: [
      // Both in central London: eleven minutes apart is realistic, so the
      // auto-fix leaves the times alone and the test measures what it claims to.
      // (Cambridge to London in eleven minutes is not, and the app correctly
      // pushed the Gallery past closing — a real conflict, not the one under test.)
      { name: "St Martin-in-the-Fields", type: 'hike', time: '4:03 PM', endTime: '4:25 PM',
        lat: 51.5089, lng: -0.1266 },
      { name: 'National Gallery', type: 'hike', time: '4:36 PM', endTime: '5:45 PM',
        lat: 51.5089, lng: -0.1283, dayHours: '10:00 AM - 6:00 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Strong.' },
      timing_conflicts: [
        { day: 1, stop_name: 'St Martin-in-the-Fields',
          issue: 'Last admission is typically 4:00 PM. Confirm with the venue.' },
        { day: 1, stop_name: 'National Gallery', scheduled_time: '4:36 PM',
          hours: '10:00 AM - 6:00 PM', issue: 'Tight but workable — move with purpose.' },
      ],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /holding the grade back/i.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const out = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('#ai-grader-content .ai-section')).map((s) => ({
      hdr: (s.querySelector('.ai-section-hdr') || {}).textContent || '',
      body: Array.from(s.querySelectorAll('.ai-item')).map((i) => i.textContent).join(' | '),
    }));
    return { sections, txt: document.getElementById('ai-grader-content').textContent };
  });
  const issues = out.sections.find((s) => /Timing Issues/.test(s.hdr));
  assert.ok(!issues, 'nothing was demonstrated, so nothing is listed: ' + JSON.stringify(issues));
  assert.ok(!/Worth checking/.test(out.txt), 'and no "worth checking" filler');
  assert.match(out.txt, /Not shown — nothing to check/, 'the user is told what was dropped');
  await page.close();
});

test('a stop you hold a ticket for is never questioned on hours', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Sat, Aug 8, 2026', stops: [
      { name: 'Royal Edinburgh Military Tattoo', type: 'hike', time: '9:00 PM', endTime: '11:00 PM',
        lat: 55.9486, lng: -3.1999, dayHours: '9:30 AM - 5:00 PM', reservation: 'TAT-4471' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Strong.' },
      timing_conflicts: [{ day: 1, stop_name: 'Royal Edinburgh Military Tattoo', severity: 'blocked',
        scheduled_time: '9:00 PM', hours: '9:30 AM - 5:00 PM', issue: 'Scheduled after closing.' }],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /holding the grade back/i.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const out = await page.evaluate(() => ({
    letter: document.querySelector('#ai-grader-content .ai-grade-letter').textContent.trim(),
    txt: document.getElementById('ai-grader-content').textContent,
  }));
  assert.equal(out.letter, 'A', 'a ticketed evening event must not cap the grade, got ' + out.letter);
  assert.ok(!/Must move/.test(out.txt), 'and must not be called impossible: ' + out.txt);
  assert.match(out.txt, /you hold a booking for that time/, 'the reason is stated');
  await page.close();
});

test('a real, unbooked closure is still reported', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Tate Modern', type: 'hike', time: '8:00 PM', endTime: '9:30 PM',
        lat: 51.5076, lng: -0.0994, dayHours: '10:00 AM - 6:00 PM' },
    ] },
  ], { day: null });
  await page.evaluate(() => {
    window.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({
      overall_grade: { letter: 'A', rationale: 'Strong.' }, timing_conflicts: [],
    }) }] }) });
  });
  await page.evaluate(async () => gradeItinerary());
  await page.waitForFunction(
    () => /Timing Issues/.test(document.getElementById('ai-grader-content').textContent),
    null, { timeout: 20000 });
  const txt = await page.evaluate(async () => document.getElementById('ai-grader-content').textContent);
  assert.match(txt, /Tate Modern/, 'filtering noise must not silence the real findings');
  assert.match(txt, /Must move/);
  await page.close();
});

test('the grader is told not to speculate and that a booking settles it', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await captureAiRequest(page);
  await page.evaluate(async () => gradeItinerary());
  const body = await aiRequestBody(page);
  assert.match(body.system, /DO NOT RAISE SPECULATION/);
  assert.match(body.system, /A BOOKING SETTLES THE QUESTION/);
  assert.match(body.system, /a hedge is worse than saying nothing/);
  await page.close();
});

// ===========================================================================
// SAVE AND RESTORE. Asked to restore yesterday's itinerary; it could not be
// done. History held descriptions with no data behind them, cloud backups ran
// weekly, and the only restore path was a hand-typed ?recover=1 URL. A copy you
// cannot put back is not a backup.
// ===========================================================================
const SR_TRIP = [
  { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
    { name: 'British Museum', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
      lat: 51.5194, lng: -0.127, reservation: 'BM-4471' },
    { name: 'Dishoom', type: 'food', time: '1:00 PM', endTime: '1:45 PM', lat: 51.5115, lng: -0.1265 },
    { name: 'Royal Horseguards', type: 'lodge', time: '8:00 PM', endTime: '9:00 PM',
      lat: 51.5063, lng: -0.1237 },
  ] },
  { title: 'Day 2', subtitle: 'Thu, Aug 6, 2026', stops: [
    { name: 'Tower of London', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
      lat: 51.5081, lng: -0.0759 },
  ] },
];

// Solo trip: no cloud, so Save/Restore must work entirely on the device.
async function openSaveTrip(days) {
  const { page } = await openTrip(days || SR_TRIP, { day: null });
  await page.evaluate(() => { localStorage.removeItem(_savesKey()); });
  return page;
}

test('Save keeps a copy and says what it kept', async () => {
  const page = await openSaveTrip();
  const out = await page.evaluate(async () => {
    window.prompt = () => 'before the AI touched it';
    await saveItinerary();
    const saves = _loadLocalSaves();
    return { n: saves.length, name: saves[0].name, days: saves[0].days, stops: saves[0].stops,
      toast: (document.getElementById('share-toast') || {}).textContent || '' };
  });
  assert.equal(out.n, 1, 'one save was kept');
  assert.equal(out.name, 'before the AI touched it');
  assert.equal(out.days, 2);
  assert.equal(out.stops, 4);
  assert.match(out.toast, /Saved/, 'and it says so: ' + out.toast);
  assert.match(out.toast, /4 stops/, 'with the counts, so a failed save is distinguishable');
  await page.close();
});

test('Restore brings back exactly what was saved', async () => {
  const page = await openSaveTrip();
  const out = await page.evaluate(async () => {
    window.prompt = () => 'good copy';
    window.confirm = () => true;
    await saveItinerary();
    // Wreck it the way a bad sync would: move a stop and delete another.
    commit('break it', () => {
      state.days[0].stops[0].time = '6:00 AM';
      state.days[0].stops.splice(1, 1);
    }, WRITE.AI);
    const broken = { time: state.days[0].stops[0].time, stops: state.days[0].stops.length };
    await openRestore();
    await restoreSaved(0);
    return { broken, time: state.days[0].stops[0].time,
      names: state.days[0].stops.map((s) => s.name),
      resv: state.days[0].stops[0].reservation };
  });
  assert.equal(out.broken.time, '6:00 AM', 'it really was broken first');
  assert.equal(out.broken.stops, 2);
  assert.equal(out.time, '10:00 AM', 'the time is back');
  assert.deepEqual(out.names, ['British Museum', 'Dishoom', 'Royal Horseguards'], 'the stop is back');
  assert.equal(out.resv, 'BM-4471', 'and so is the confirmation number');
  await page.close();
});

// THE TRAP: restoring a smaller copy is exactly the write _wouldLoseData exists
// to refuse. Without force it is silently blocked and Restore does nothing.
test('restoring a much smaller copy succeeds, but only deliberately', async () => {
  // Start SMALL and grow. Trimming a 12-stop day to 3 is itself the write the
  // brake refuses, so building the fixture that way never got off the ground.
  const small = [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops:
    Array.from({ length: 3 }, (_, i) => ({ name: 'Stop ' + (i + 1), type: 'hike',
      time: (8 + i) + ':00 AM', endTime: (8 + i) + ':45 AM', lat: 51.5 + i / 100, lng: -0.12 })) }];
  const page = await openSaveTrip(small);
  const out = await page.evaluate(async () => {
    window.prompt = () => 'small';
    window.confirm = () => true;
    await saveItinerary();
    // Grow well beyond double, which is allowed.
    commit('add them back', () => {
      for (let i = 0; i < 9; i++) {
        state.days[0].stops.push({ name: 'Extra ' + i, type: 'hike', time: '2:00 PM',
          endTime: '2:30 PM', lat: 51.6 + i / 100, lng: -0.12 });
      }
    }, WRITE.USER);
    const grown = state.days[0].stops.length;
    // Without force, the brake must refuse this.
    const blocked = commitReplace('no force', JSON.parse(JSON.stringify(_loadLocalSaves()[0].state)), WRITE.USER);
    const afterBlocked = state.days[0].stops.length;
    // Through the Restore button, it must go through.
    await openRestore();
    await restoreSaved(_restoreList.findIndex((e) => e.name === 'small'));
    return { grown, blocked, afterBlocked, afterRestore: state.days[0].stops.length };
  });
  assert.equal(out.grown, 12);
  assert.equal(out.blocked, false, 'the brake refuses an unforced shrink');
  assert.equal(out.afterBlocked, 12, 'and nothing changed');
  assert.equal(out.afterRestore, 3, 'Restore goes through deliberately, got ' + out.afterRestore);
  await page.close();
});

test('force skips only the loss brake, never the structural check', async () => {
  const page = await openSaveTrip();
  const out = await page.evaluate(() => {
    const before = JSON.stringify(state);
    const ok = commitReplace('corrupt', { days: 'not an array' }, WRITE.USER, { force: true });
    return { ok, unchanged: JSON.stringify(state) === before };
  });
  assert.equal(out.ok, false, 'a structurally broken copy is refused even with force');
  assert.ok(out.unchanged, 'and the itinerary is untouched');
  await page.close();
});

test('a restore is itself recorded, so it can be undone too', async () => {
  const page = await openSaveTrip();
  const log = await page.evaluate(async () => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    window.prompt = () => 'checkpoint';
    window.confirm = () => true;
    _markCommitted();
    await saveItinerary();
    commit('later edit', () => { state.days[0].stops[0].notes = 'changed'; }, WRITE.USER);
    await openRestore();
    await restoreSaved(0);
    return _loadChangeLog().map((e) => e.desc);
  });
  assert.ok(log.some((d) => /Saved a copy: "checkpoint"/.test(d)), 'the save is logged: ' + JSON.stringify(log));
  assert.ok(log.some((d) => /Restored "checkpoint"/.test(d)), 'and so is the restore');
  await page.close();
});

test('the Save and Restore buttons are on the trip overview', async () => {
  const page = await openSaveTrip();
  // Make sure we are actually on the Overview before looking for its header.
  await page.evaluate(async () => switchDay(-1));
  await page.waitForFunction(
    () => !!document.querySelector('.ov-trip-head'), null, { timeout: 15000 });
  const btns = await page.evaluate(async () =>
    Array.from(document.querySelectorAll('.ov-trip-head .ai-action-btn')).map((b) => b.textContent.trim()));
  assert.ok(btns.some((b) => /Save/.test(b)), 'a Save button exists: ' + JSON.stringify(btns));
  assert.ok(btns.some((b) => /Restore/.test(b)), 'and a Restore button: ' + JSON.stringify(btns));
  await page.close();
});

test('Restore says so plainly when there is nothing saved yet', async () => {
  const page = await openSaveTrip();
  const txt = await page.evaluate(async () => {
    await openRestore();
    return document.getElementById('trip-recap-content').textContent;
  });
  assert.match(txt, /No saved copies yet/, 'got: ' + txt);
  assert.match(txt, /Save/, 'and points at the button that fixes that');
  await page.close();
});

test('the oldest saves are dropped, the newest kept', async () => {
  const page = await openSaveTrip();
  const out = await page.evaluate(async () => {
    for (let i = 0; i < SAVE_KEEP + 5; i++) {
      window.prompt = () => 'save ' + i;
      await saveItinerary();
    }
    const s = _loadLocalSaves();
    return { n: s.length, first: s[0].name, last: s[s.length - 1].name };
  });
  assert.equal(out.n, 25, 'capped at SAVE_KEEP, got ' + out.n);
  assert.equal(out.last, 'save 29', 'newest kept');
  assert.equal(out.first, 'save 5', 'oldest dropped');
  await page.close();
});

// ===========================================================================
// THE JUNE-14 OVERWRITE. Reported: the itinerary reverted to a version from
// weeks earlier. _syncFamily read the cloud copy ONLY to count stops, and
// _wouldLoseData blocks a push only when it drops more than HALF the stops — so
// an old copy with a similar number of stops overwrote the current one. Nothing
// checked whether the pushing device had ever SEEN the version it replaced.
// ===========================================================================
async function openFamilyTrip(days, cloud) {
  // The service worker intercepts fetches and page.route does NOT see them, so
  // every Firebase read in a normal test page fails at the network and the app
  // silently takes its "cannot reach the cloud" path. Blocking the worker is
  // what makes the sync path actually testable.
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const puts = [];
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    if (u.includes('firebaseio.com')) {
      const m = route.request().method();
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body });
      if (m === 'PUT') { puts.push({ url: u, body: route.request().postData() }); return json('null'); }
      if (/\/lastChange\.json/.test(u)) return json(JSON.stringify(cloud.lastChange));
      if (/\/version\.json/.test(u)) return json(JSON.stringify(cloud.version ?? null));
      if (/\/state\.json/.test(u)) return json(JSON.stringify(cloud.state));
      return json(JSON.stringify({ state: cloud.state, lastChange: cloud.lastChange,
        version: cloud.version ?? null }));
    }
    // Real Leaflet, or trip.js throws during init and never sets up `state`.
    if (u.includes('leaflet')) {
      const ext = u.endsWith('.css') ? '.css' : '.js';
      const lf = path.join(LEAFLET_DIR, 'leaflet' + ext);
      if (fs.existsSync(lf)) return route.fulfill({ status: 200,
        contentType: ext === '.css' ? 'text/css' : 'application/javascript', body: fs.readFileSync(lf) });
    }
    if (u.includes('tile.openstreetmap.org')) return route.fulfill({ status: 200, contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    if (u.includes('unpkg.com') || u.includes('cdnjs')) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'void 0;' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.addInitScript((d) => {
    localStorage.setItem('tripState_london-scotland',
      JSON.stringify({ tripType: 'family', title: 'Test', days: d }));
    localStorage.setItem('tripFamily_london-scotland', '1');
  }, days);
  await page.goto(`${origin}/Travel/trip.html?id=london-scotland&fam=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state && Array.isArray(state.days),
    null, { timeout: 20000 });
  return { page, puts };
}

// A stale device: 11 stops from weeks ago. The cloud has 12 — similar enough
// that the loss brake never fires.
const STALE = [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops:
  Array.from({ length: 11 }, (_, i) => ({ name: 'OLD ' + i, type: 'hike',
    time: (8 + (i % 10)) + ':00 AM', endTime: (8 + (i % 10)) + ':45 AM', lat: 51.5 + i / 100, lng: -0.12 })) }];
const CURRENT = { days: [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops:
  Array.from({ length: 12 }, (_, i) => ({ name: 'CURRENT ' + i, type: 'hike',
    time: (8 + (i % 10)) + ':00 AM', endTime: (8 + (i % 10)) + ':45 AM', lat: 51.5 + i / 100, lng: -0.12 })) }],
  tripType: 'family', title: 'Test' };

test('a device that has not seen the current copy cannot overwrite it', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 47,
    lastChange: { at: Date.now() + 5_000_000, by: 'other-device', desc: 'edits from the other phone', version: 47 },
  });
  // Count only what happens AFTER the trigger; loading the page can push on its
  // own, which is itself the same failure and is covered by its own test below.
  const before = puts.filter((p) => /\/state\.json/.test(p.url)).length;
  const out = await page.evaluate(async () => {
    _knownVersion = 12;                    // this device is far behind the head
    _syncFamily('an edit from the stale device');
    await new Promise((r) => setTimeout(r, 1500));
    return { toast: (document.getElementById('share-toast') || {}).textContent || '',
      log: _loadChangeLog().map((e) => e.desc + '|' + (e.refused || '')) };
  });
  const stateWrites = puts.filter((p) => /\/state\.json/.test(p.url)).slice(before);
  assert.equal(stateWrites.length, 0,
    'the stale copy must never reach the shared itinerary, got ' + stateWrites.length + ' writes');
  assert.match(out.toast, /NOT SYNCED/, 'and the user is told: ' + out.toast);
  assert.ok(out.log.some((l) => /holds version 12 but the shared trip is at 47/.test(l)),
    'and it is recorded: ' + JSON.stringify(out.log));
  await page.close();
});

test('a device that IS up to date still syncs normally', async () => {
  const at = Date.now() - 10_000;
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 20,
    lastChange: { at, by: 'other-device', desc: 'an earlier change we already have', version: 20 },
  });
  const before2 = puts.filter((p) => /\/state\.json/.test(p.url)).length;
  await page.evaluate(async (seen) => {
    _knownVersion = 20;                    // we hold the head
    _syncFamily('a legitimate edit');
    await new Promise((r) => setTimeout(r, 1500));
  }, at);
  const stateWrites = puts.filter((p) => /\/state\.json/.test(p.url)).slice(before2);
  assert.equal(stateWrites.length, 1, 'an up-to-date device must still be able to save');
  await page.close();
});

test('our own change is not mistaken for someone else moving ahead', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 31,
    lastChange: { at: Date.now() + 5_000_000, by: 'THIS-SESSION', desc: 'our own push', version: 31 },
  });
  const before3 = puts.filter((p) => /\/state\.json/.test(p.url)).length;
  await page.evaluate(async () => {
    sessionStorage.setItem('_csid', 'THIS-SESSION');
    _knownVersion = 31;
    _syncFamily('a follow-up edit');
    await new Promise((r) => setTimeout(r, 1500));
  });
  const stateWrites = puts.filter((p) => /\/state\.json/.test(p.url)).slice(before3);
  assert.equal(stateWrites.length, 1,
    'a device must not block itself, got ' + stateWrites.length + ' writes');
  await page.close();
});

test('a device that cannot reach the shared copy does not push blind', async () => {
  // The cloud is unreachable. Previously `cloud` stayed null, the loss brake had
  // nothing to compare against, and the device pushed its local copy anyway.
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const puts = [];
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin)) return route.continue();
    if (u.includes('firebaseio.com')) {
      if (route.request().method() === 'PUT') {
        puts.push({ url: u });
        return route.fulfill({ status: 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' }, body: 'null' });
      }
      return route.abort();                        // reads genuinely fail
    }
    if (u.includes('leaflet')) {
      const ext = u.endsWith('.css') ? '.css' : '.js';
      const lf = path.join(LEAFLET_DIR, 'leaflet' + ext);
      if (fs.existsSync(lf)) return route.fulfill({ status: 200,
        contentType: ext === '.css' ? 'text/css' : 'application/javascript', body: fs.readFileSync(lf) });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.addInitScript((d) => {
    localStorage.setItem('tripState_london-scotland',
      JSON.stringify({ tripType: 'family', title: 'Test', days: d }));
    localStorage.setItem('tripFamily_london-scotland', '1');
  }, STALE);
  await page.goto(`${origin}/Travel/trip.html?id=london-scotland&fam=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state && Array.isArray(state.days),
    null, { timeout: 20000 });
  const before = puts.filter((p) => /\/state\.json/.test(p.url)).length;
  const toast = await page.evaluate(async () => {
    _syncFamily('an edit while the cloud is down');
    await new Promise((r) => setTimeout(r, 1500));
    return (document.getElementById('share-toast') || {}).textContent || '';
  });
  const writes = puts.filter((p) => /\/state\.json/.test(p.url)).slice(before);
  assert.equal(writes.length, 0, 'a blind overwrite must never happen, got ' + writes.length);
  assert.match(toast, /NOT SYNCED/, 'and the user is told: ' + toast);
  await page.close();
});

// ===========================================================================
// v209 — RESTORE FROM A FILE. The Restore panel listed only saved copies and
// automatic backups. When every automatic backup holds the same corrupted copy,
// that list is worthless — and a correct itinerary in a file had nowhere to go.
// ===========================================================================
const GOOD_FILE = {
  tripType: 'family', title: 'UK & Scotland Family Trip 2026',
  days: [
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Flight Z0 784 — MCO to LGW', type: 'flight', time: '8:30 PM', endTime: '10:00 AM',
        lat: 28.4312, lng: -81.3081, reservation: 'Z0784' }] },
    { title: 'Day 4', subtitle: 'Fri, Aug 7, 2026', stops: [
      { name: 'Lincoln Cathedral', type: 'hike', time: '1:52 PM', endTime: '2:52 PM',
        lat: 53.2344, lng: -0.5361 },
      { name: 'Lincoln Castle', type: 'hike', time: '2:57 PM', endTime: '4:00 PM',
        lat: 53.2345, lng: -0.5405 }] },
  ],
};

async function openRestorePanel(page) {
  await page.evaluate(async () => openRestore());
  await page.waitForSelector('#restore-file', { state: 'attached', timeout: 15000 });
}
// Feed the panel a file the way a real picker would.
async function chooseRestoreFile(page, name, obj) {
  await page.evaluate(({ name, text }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: 'application/json' }));
    const input = document.getElementById('restore-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { name, text: JSON.stringify(obj) });
  await page.waitForFunction(
    () => (document.getElementById('restore-file-verdict') || {}).textContent, null, { timeout: 15000 });
}

test('the Restore panel takes a file', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await openRestorePanel(page);
  const has = await page.evaluate(async () => !!document.getElementById('restore-file'));
  assert.ok(has, 'there is a file picker in the Restore panel');
  await page.close();
});

test('choosing a good file shows what is in it', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await openRestorePanel(page);
  await chooseRestoreFile(page, 'london-scotland-FINAL.json', GOOD_FILE);
  const out = await page.evaluate(() => ({
    verdict: document.getElementById('restore-file-verdict').textContent,
    canRestore: /Restore from this file/.test(document.getElementById('restore-file-actions').innerHTML),
  }));
  assert.match(out.verdict, /london-scotland-FINAL\.json/, 'names the file: ' + out.verdict);
  assert.match(out.verdict, /2 days/, 'and states what is in it');
  assert.match(out.verdict, /3 stops/);
  assert.ok(out.canRestore, 'and offers to restore it');
  await page.close();
});

test('restoring from a file replaces the itinerary with exactly that file', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await page.evaluate(() => { window.confirm = () => true; });
  await openRestorePanel(page);
  await chooseRestoreFile(page, 'london-scotland-FINAL.json', GOOD_FILE);
  const out = await page.evaluate(async () => {
    await _restoreFromFile();
    return { days: state.days.length,
      stops: state.days.reduce((n, d) => n + d.stops.length, 0),
      lincoln: /lincoln/i.test(JSON.stringify(state)),
      resv: state.days[0].stops[0].reservation,
      log: _loadChangeLog().map((e) => e.desc) };
  });
  assert.equal(out.days, 2);
  assert.equal(out.stops, 3, 'exactly the file, got ' + out.stops);
  assert.ok(out.lincoln, 'Lincoln is in the restored itinerary');
  assert.equal(out.resv, 'Z0784', 'confirmation numbers come across');
  assert.ok(out.log.some((d) => /Restored from london-scotland-FINAL\.json/.test(d)),
    'and the restore is logged by name: ' + JSON.stringify(out.log.slice(-3)));
  await page.close();
});

test('a file with FEWER stops still restores — that is the whole point', async () => {
  // WP_DAY has more stops than GOOD_FILE. The catastrophic-loss brake would
  // normally refuse this exact write; a deliberate restore must override it.
  const big = [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops:
    Array.from({ length: 12 }, (_, i) => ({ name: 'Stop ' + i, type: 'hike',
      time: (8 + (i % 10)) + ':00 AM', endTime: (8 + (i % 10)) + ':45 AM', lat: 51.5 + i / 100, lng: -0.12 })) }];
  const { page } = await openTrip(big, { day: null });
  await page.evaluate(() => { window.confirm = () => true; });
  await openRestorePanel(page);
  await chooseRestoreFile(page, 'smaller.json', GOOD_FILE);
  const stops = await page.evaluate(async () => { await _restoreFromFile();
    return state.days.reduce((n, d) => n + d.stops.length, 0); });
  assert.equal(stops, 3, 'the smaller file won, got ' + stops + ' stops');
  await page.close();
});

test('a file that is not an itinerary is refused, and nothing changes', async () => {
  const { page } = await openTrip(WP_DAY, { day: null });
  await openRestorePanel(page);
  await chooseRestoreFile(page, 'notes.json', { hello: 'world' });
  const out = await page.evaluate(() => ({
    verdict: document.getElementById('restore-file-verdict').textContent,
    actions: document.getElementById('restore-file-actions').innerHTML,
    stops: state.days.reduce((n, d) => n + d.stops.length, 0),
  }));
  assert.match(out.verdict, /not an itinerary/i, 'says why: ' + out.verdict);
  assert.equal(out.actions, '', 'and offers no way to restore it');
  assert.equal(out.stops, 4, 'the itinerary is untouched');   // WP_DAY: 3 + 1
  await page.close();
});

// ===========================================================================
// REPORTED AFTER v209: a stop cannot be deleted, and tickets have vanished.
// ===========================================================================
test('deleting a stop actually removes it', async () => {
  const { page } = await openTrip(WP_DAY);
  await page.evaluate(() => { window.confirm = () => true; });
  const out = await page.evaluate(() => {
    const before = state.days[0].stops.map((s) => s.name);
    deleteStop(0, 1);
    return { before, after: state.days[0].stops.map((s) => s.name),
      log: _loadChangeLog().slice(-3).map((e) => e.desc + '|' + (e.refused || '')) };
  });
  assert.equal(out.after.length, out.before.length - 1,
    'one stop should be gone. before=' + JSON.stringify(out.before)
      + ' after=' + JSON.stringify(out.after) + ' log=' + JSON.stringify(out.log));
  assert.ok(!out.after.includes('Dishoom'), 'the right stop went');
});

test('deleting the LAST stop on a day works too', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Only stop', type: 'hike', time: '10:00 AM', endTime: '11:00 AM', lat: 51.5, lng: -0.12 }] },
    { title: 'Day 2', subtitle: 'Thu, Aug 6, 2026', stops: [
      { name: 'Another', type: 'hike', time: '10:00 AM', endTime: '11:00 AM', lat: 51.51, lng: -0.13 }] },
  ]);
  await page.evaluate(() => { window.confirm = () => true; });
  const out = await page.evaluate(() => {
    deleteStop(0, 0);
    return { n: state.days[0].stops.length,
      log: _loadChangeLog().slice(-3).map((e) => e.desc + '|' + (e.refused || '')) };
  });
  assert.equal(out.n, 0, 'the day empties. log=' + JSON.stringify(out.log));
});

test('deleting a stop from a big day is not blocked by the loss brake', async () => {
  const big = [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops:
    Array.from({ length: 14 }, (_, i) => ({ name: 'Stop ' + i, type: 'hike',
      time: (8 + (i % 12)) + ':00 AM', endTime: (8 + (i % 12)) + ':45 AM',
      lat: 51.5 + i / 100, lng: -0.12 })) }];
  const { page } = await openTrip(big);
  await page.evaluate(() => { window.confirm = () => true; });
  const out = await page.evaluate(() => {
    deleteStop(0, 5);
    return { n: state.days[0].stops.length,
      log: _loadChangeLog().slice(-3).map((e) => e.desc + '|' + (e.refused || '')) };
  });
  assert.equal(out.n, 13, 'thirteen left. log=' + JSON.stringify(out.log));
});

// ===========================================================================
// TICKET STORE. A ticket kept inside the itinerary travels in the same blob
// that goes to localStorage on every keystroke — one 2.3 MB confirmation put
// the trip over the ~5 MB quota and every save failed silently. Tickets now
// live in the Cache API and the stop keeps a reference, so a restore brings
// them back without carrying megabytes through every save.
// ===========================================================================
const PDF_URI = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 fake ticket').toString('base64');
const TICKET_DAY = [
  { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
    { name: 'Tower of London', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
      lat: 51.5081, lng: -0.0759, reservation: 'TOL-771',
      ticketImage: PDF_URI, ticketFileName: 'tower.pdf' },
    { name: 'British Museum', type: 'hike', time: '1:00 PM', endTime: '3:00 PM',
      lat: 51.5194, lng: -0.127 },
  ] },
];

test('a ticket is moved out of the itinerary into the store', async () => {
  const { page } = await openTrip(TICKET_DAY);
  await page.waitForFunction(
    () => state.days[0].stops[0].ticketRef && !state.days[0].stops[0].ticketImage,
    null, { timeout: 15000 });
  const out = await page.evaluate(async () => {
    const s = state.days[0].stops[0];
    return { ref: s.ref || s.ticketRef, inline: !!s.ticketImage, mime: s.ticketMime,
      resolved: await _stopTicketData(s), hasTicket: _stopHasTicket(s), booked: _isBooked(s) };
  });
  assert.ok(out.ref, 'the stop keeps a reference');
  assert.equal(out.inline, false, 'and no longer carries the blob');
  assert.equal(out.mime, 'application/pdf', 'the type is remembered');
  assert.ok(out.resolved.startsWith('data:application/pdf'), 'and the ticket reads back');
  assert.ok(out.hasTicket, 'the app still knows it has a ticket');
  assert.ok(out.booked, 'and still treats the stop as booked');
  await page.close();
});

test('moving a ticket out shrinks the saved itinerary', async () => {
  const { page } = await openTrip(TICKET_DAY);
  await page.waitForFunction(
    () => state.days[0].stops[0].ticketRef, null, { timeout: 15000 });
  const bytes = await page.evaluate(async () => JSON.stringify(state).length);
  assert.ok(bytes < 4000, 'the itinerary no longer carries the ticket, got ' + bytes + ' bytes');
  await page.close();
});

test('a stored ticket survives a restore', async () => {
  const { page } = await openTrip(TICKET_DAY);
  await page.evaluate(() => { window.confirm = () => true; });
  await page.waitForFunction(
    () => state.days[0].stops[0].ticketRef, null, { timeout: 15000 });
  const out = await page.evaluate(async () => {
    // Save, wreck the itinerary, then restore — the ticket must come back.
    const snapshot = JSON.parse(JSON.stringify(state));
    _writeLocalSaves([{ at: Date.now(), name: 'before', by: 'x',
      days: 1, stops: 2, state: snapshot }]);
    commit('wreck it', () => { state.days[0].stops[0].reservation = ''; delete state.days[0].stops[0].ticketRef; }, WRITE.USER);
    _restoreList = await _gatherRestorable();
    await restoreSaved(0);
    const s = state.days[0].stops[0];
    return { ref: s.ticketRef, data: await _stopTicketData(s), resv: s.reservation };
  });
  assert.ok(out.ref, 'the reference came back with the restore');
  assert.ok(out.data.startsWith('data:application/pdf'),
    'and the ticket itself still resolves — the store outlives the itinerary');
  assert.equal(out.resv, 'TOL-771', 'the confirmation number too');
  await page.close();
});

test('a ticket that cannot be found says so instead of doing nothing', async () => {
  const { page } = await openTrip(TICKET_DAY);
  await page.waitForFunction(
    () => state.days[0].stops[0].ticketRef, null, { timeout: 15000 });
  const msg = await page.evaluate(async () => {
    state.days[0].stops[0].ticketRef = 'missing-ref';
    _ticketMem = {};
    await showTicketViewer(0, 0);
    return (document.getElementById('share-toast') || {}).textContent || '';
  });
  assert.match(msg, /could not be found/i, 'the user is told: ' + msg);
  await page.close();
});

test('a stop with no ticket is unaffected', async () => {
  const { page } = await openTrip(TICKET_DAY);
  const out = await page.evaluate(() => {
    const s = state.days[0].stops[1];
    return { has: _stopHasTicket(s), booked: _isBooked(s) };
  });
  assert.equal(out.has, false);
  assert.equal(out.booked, false);
  await page.close();
});

test('the same ticket on two stops is stored once', async () => {
  const { page } = await openTrip([
    { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'Hotel — Check In', type: 'lodge', time: '10:00 AM', endTime: '10:30 AM',
        lat: 51.5062, lng: -0.1228, ticketImage: PDF_URI, ticketFileName: 'hotel.pdf' },
      { name: 'Hotel', type: 'lodge', time: '9:30 PM', endTime: '10:00 PM',
        lat: 51.5062, lng: -0.1228, ticketImage: PDF_URI, ticketFileName: 'hotel.pdf' },
    ] },
  ]);
  await page.waitForFunction(
    () => state.days[0].stops.every((s) => s.ticketRef), null, { timeout: 15000 });
  const out = await page.evaluate(async () => {
    const [a, b] = state.days[0].stops;
    // ONE reference for the same bytes is what "stored once" means — counting
    // cache entries is a race, because the cache is shared across tests.
    return { same: a.ticketRef === b.ticketRef, ref: a.ticketRef,
      fromA: await _stopTicketData(a), fromB: await _stopTicketData(b),
      // The same content must always produce the same id.
      stable: (await _ticketId('data:application/pdf;base64,AAAA'))
            === (await _ticketId('data:application/pdf;base64,AAAA')),
      differs: (await _ticketId('data:application/pdf;base64,AAAA'))
            !== (await _ticketId('data:application/pdf;base64,BBBB')) };
  });
  assert.ok(out.same, 'both stops point at the same ticket, got ' + out.ref);
  assert.equal(out.fromA, out.fromB, 'and both open the same bytes');
  assert.ok(out.fromB.startsWith('data:application/pdf'), 'which are the ticket');
  assert.ok(out.stable, 'the same file always gets the same id');
  assert.ok(out.differs, 'and different files do not collide');
  await page.close();
});

// ===========================================================================
// A LOCKED TIME IS A RESERVATION. It must survive a save, a restore, an edit
// and an export — losing it silently moves a booked table or a timed entry.
// ===========================================================================
const LOCK_DAY = [
  { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
    { name: "St Paul's Cathedral", type: 'hike', time: '2:00 PM', endTime: '3:25 PM',
      lat: 51.5138, lng: -0.0984, locked: true },
    { name: 'Tower of London', type: 'hike', time: '3:30 PM', endTime: '5:00 PM',
      lat: 51.5081, lng: -0.0759, locked: true, reservation: 'TOL-771' },
    { name: 'Dinner', type: 'food', time: '7:00 PM', endTime: '8:15 PM',
      lat: 51.5121, lng: -0.1241 },
  ] },
];

test('a locked time survives a save and restore', async () => {
  const { page } = await openTrip(LOCK_DAY);
  await page.evaluate(() => { window.confirm = () => true; });
  const out = await page.evaluate(async () => {
    _writeLocalSaves([{ at: Date.now(), name: 'with locks', by: 'x', days: 1, stops: 3,
      state: JSON.parse(JSON.stringify(state)) }]);
    commit('unlock everything', () => { state.days[0].stops.forEach((s) => { delete s.locked; }); }, WRITE.USER);
    _restoreList = await _gatherRestorable();
    await restoreSaved(0);
    return state.days[0].stops.map((s) => !!s.locked);
  });
  assert.deepEqual([...out], [true, true, false], 'the locks came back, got ' + JSON.stringify(out));
  await page.close();
});

test('losing a lock is recorded, not silent', async () => {
  const { page } = await openTrip(LOCK_DAY);
  const losses = await page.evaluate(() => {
    localStorage.removeItem(_changeLogKey()); _changeLog = null;
    _markCommitted();
    commit('rebuild the stop without its lock', () => {
      state.days[0].stops[0] = { name: "St Paul's Cathedral", type: 'hike',
        time: '2:00 PM', endTime: '3:25 PM', lat: 51.5138, lng: -0.0984 };
    }, WRITE.USER);
    const log = _loadChangeLog();
    return log[log.length - 1].losses || [];
  });
  assert.ok(losses.some((l) => /locked/.test(l)),
    'a dropped lock must be reported, got ' + JSON.stringify(losses));
  await page.close();
});

test('a locked time is not moved by the auto-fix', async () => {
  const { page } = await openTrip(LOCK_DAY);
  const out = await page.evaluate(() => {
    const before = state.days[0].stops[1].time;
    // Force a retime of the day; the locked stop must hold its slot.
    _retimeFromPrev(state.days[0].stops, 1);
    return { before, after: state.days[0].stops[1].time };
  });
  assert.equal(out.after, out.before, 'a reservation holds its time, was ' + out.before + ' now ' + out.after);
  await page.close();
});

test('the Excel export carries the lock and the end time', async () => {
  const { page } = await openTrip(LOCK_DAY, { day: null });
  const rows = await page.evaluate(() => {
    let captured = null;
    const realAoA = XLSX.utils.aoa_to_sheet;
    XLSX.utils.aoa_to_sheet = (r) => { if (!captured) captured = r; return realAoA(r); };
    XLSX.writeFile = () => {};                       // do not actually download
    try { downloadExcel(); } catch (e) { /* ignore */ }
    XLSX.utils.aoa_to_sheet = realAoA;
    return captured;
  });
  assert.ok(rows, 'the export ran');
  const header = rows[0];
  assert.ok(header.includes('Locked'), 'there is a Locked column, got ' + JSON.stringify(header));
  assert.ok(header.includes('End Time'), 'and an End Time column');
  const li = header.indexOf('Locked'), pi = header.indexOf('Place'), ei = header.indexOf('End Time');
  const stPauls = rows.find((r) => String(r[pi]).includes("St Paul"));
  const dinner = rows.find((r) => String(r[pi]) === 'Dinner');
  assert.equal(stPauls[li], 'LOCKED', 'a locked stop is marked');
  assert.equal(stPauls[ei], '3:25 PM', 'and its end time is exported');
  assert.equal(dinner[li], '', 'an unlocked stop is not');
  await page.close();
});

// ===========================================================================
// VERSION CONTROL. Wall-clock timestamps say nothing about lineage: a device
// closed for weeks can hold an ancient copy and still have the later clock
// reading, which is how a weeks-old itinerary overwrote everyone. A version
// number cannot be wrong about that — you may only write N+1 holding N.
// A human restore can still force it through; nothing automatic can.
// ===========================================================================
async function pushOnce(page, fn) {
  const before = Date.now();
  await page.evaluate(fn);
  await page.waitForTimeout(1500);
  return before;
}
const stateWrites = (puts) => puts.filter((p) => /\/state\.json/.test(p.url));
const versionWrites = (puts) => puts.filter((p) => /\/version\.json/.test(p.url));

test('a device holding an old version cannot write over the head', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 47,
    lastChange: { at: Date.now(), by: 'other', desc: 'their edits', version: 47 },
  });
  const n = stateWrites(puts).length;
  const log = await page.evaluate(async () => {
    _knownVersion = 12;
    _syncFamily('an edit from three weeks ago');
    await new Promise((r) => setTimeout(r, 1500));
    return _loadChangeLog().map((e) => e.desc + '|' + (e.refused || ''));
  });
  assert.equal(stateWrites(puts).length - n, 0, 'nothing was written');
  assert.ok(log.some((l) => /stale version/.test(l)), 'and it says why: ' + JSON.stringify(log.slice(-2)));
  await page.close();
});

test('reading the head makes a device writable again, and it lands at head+1', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 47,
    lastChange: { at: Date.now(), by: 'other', desc: 'their edits', version: 47 },
  });
  const n = versionWrites(puts).length;
  await pushOnce(page, async () => {
    _knownVersion = 47;                       // this is what adopting the head does
    _syncFamily('an edit made from the current copy');
    await new Promise((r) => setTimeout(r, 1400));
  });
  const vw = versionWrites(puts).slice(n);
  assert.equal(vw.length, 1, 'the version was written once, got ' + vw.length);
  assert.equal(JSON.parse(vw[0].body), 48, 'as head+1, got ' + vw[0].body);
  await page.close();
});

test('a device that has never read the head is refused', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 47,
    lastChange: { at: Date.now(), by: 'other', desc: 'x', version: 47 },
  });
  const n = stateWrites(puts).length;
  await pushOnce(page, async () => {
    _knownVersion = null;                     // cold, never adopted
    _syncFamily('a blind edit');
    await new Promise((r) => setTimeout(r, 1400));
  });
  assert.equal(stateWrites(puts).length - n, 0, 'it must not guess');
  await page.close();
});

test('a copy loaded from the bundled plan is never pushed', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 47,
    lastChange: { at: Date.now(), by: 'other', desc: 'x', version: 47 },
  });
  const n = stateWrites(puts).length;
  const log = await page.evaluate(async () => {
    state._provisional = true; _knownVersion = 47;
    _syncFamily('an edit on a placeholder copy');
    await new Promise((r) => setTimeout(r, 1400));
    return _loadChangeLog().map((e) => e.desc + '|' + (e.refused || ''));
  });
  assert.equal(stateWrites(puts).length - n, 0, 'a placeholder is not an authority');
  assert.ok(log.some((l) => /provisional/.test(l)), 'and it says so: ' + JSON.stringify(log.slice(-2)));
  await page.close();
});

test('THE OVERRIDE: a person can push from a stale device, and it is recorded', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 47,
    lastChange: { at: Date.now(), by: 'other', desc: 'x', version: 47 },
  });
  const sn = stateWrites(puts).length, vn = versionWrites(puts).length;
  const log = await page.evaluate(async () => {
    _knownVersion = 12;                        // as stale as it gets
    await _pushOverride(JSON.parse(JSON.stringify(state)), 'Restored from a file (override)');
    return _loadChangeLog().map((e) => e.desc);
  });
  assert.equal(stateWrites(puts).length - sn, 1, 'the override wrote the state');
  const vw = versionWrites(puts).slice(vn);
  assert.equal(JSON.parse(vw[0].body), 48, 'still head+1, so the counter stays sane');
  assert.ok(log.some((d) => /OVERRIDE/.test(d)), 'and it is recorded as an override: ' + JSON.stringify(log.slice(-2)));
  await page.close();
});

test('the override banks the copy it replaces before overwriting it', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 47,
    lastChange: { at: Date.now(), by: 'other', desc: 'x', version: 47 },
  });
  await page.evaluate(async () => {
    _knownVersion = 12;
    await _pushOverride(JSON.parse(JSON.stringify(state)), 'override');
  });
  const banked = puts.filter((p) => /\/history\//.test(p.url));
  assert.ok(banked.length >= 1, 'the replaced copy was banked first, got ' + banked.length);
  await page.close();
});

test('no automatic path can reach the override', async () => {
  const { page, puts } = await openFamilyTrip(STALE, {
    state: CURRENT, version: 47,
    lastChange: { at: Date.now(), by: 'other', desc: 'x', version: 47 },
  });
  const n = stateWrites(puts).length;
  await pushOnce(page, async () => {
    _knownVersion = 12;
    // Every ordinary route into the sync, with every shape of options.
    _syncFamily('plain');
    _syncFamily('with force', { force: true });
    saveState('via saveState', false, { force: true });
    await new Promise((r) => setTimeout(r, 1400));
  });
  assert.equal(stateWrites(puts).length - n, 0,
    'only a person may override, got ' + (stateWrites(puts).length - n) + ' writes');
  await page.close();
});

// ===========================================================================
// PLAYBACK SPEED. iOS Safari draws <audio controls> as a bare play/scrub bar —
// the three-dot menu carrying "Playback speed" is desktop-only, so on an iPhone
// there was no way to speed up or slow down a tour at all.
// ===========================================================================
const AUDIO_DAY = [
  { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
    { name: 'Westminster Abbey', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
      lat: 51.4994, lng: -0.1273, audioUrl: 'https://example.com/abbey.mp3' },
    { name: 'British Museum', type: 'hike', time: '1:00 PM', endTime: '3:00 PM',
      lat: 51.5194, lng: -0.127, audioUrl: 'https://example.com/museum.mp3' },
  ] },
];

test('an audio tour has a speed control the app draws itself', async () => {
  const { page } = await openTrip(AUDIO_DAY);
  await page.waitForFunction(
    () => document.querySelectorAll('.audio-rate-btn').length >= 2, null, { timeout: 15000 });
  const out = await page.evaluate(() => {
    const b = document.querySelector('.audio-rate-btn');
    return { label: b.textContent, title: b.title,
      rate: document.querySelector('audio').playbackRate };
  });
  assert.equal(out.label, '1×', 'it starts at normal speed, got ' + out.label);
  assert.match(out.title, /speed/i, 'and says what it does');
  assert.equal(out.rate, 1);
  await page.close();
});

test('tapping it cycles the speed and applies it to the player', async () => {
  const { page } = await openTrip(AUDIO_DAY);
  await page.waitForFunction(
    () => document.querySelector('.audio-rate-btn'), null, { timeout: 15000 });
  const seq = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 6; i++) {
      document.querySelector('.audio-rate-btn').click();
      out.push({ label: document.querySelector('.audio-rate-btn').textContent,
        rate: document.querySelector('audio').playbackRate });
    }
    return out;
  });
  assert.deepEqual(seq.map((x) => x.label), ['1.25×', '1.5×', '1.75×', '2×', '0.75×', '1×'],
    'it cycles through the useful rates, got ' + JSON.stringify(seq.map((x) => x.label)));
  assert.equal(seq[0].rate, 1.25, 'and the player actually changes speed');
  assert.equal(seq[3].rate, 2);
  await page.close();
});

test('the speed applies to every tour, not one at a time', async () => {
  const { page } = await openTrip(AUDIO_DAY);
  await page.waitForFunction(
    () => document.querySelectorAll('audio').length >= 2, null, { timeout: 15000 });
  const out = await page.evaluate(() => {
    document.querySelector('.audio-rate-btn').click();          // -> 1.25
    return { rates: Array.from(document.querySelectorAll('audio')).map((a) => a.playbackRate),
      labels: Array.from(document.querySelectorAll('.audio-rate-btn')).map((b) => b.textContent) };
  });
  assert.deepEqual([...out.rates], [1.25, 1.25], 'both players changed, got ' + JSON.stringify(out.rates));
  assert.deepEqual([...out.labels], ['1.25×', '1.25×'], 'and both buttons agree');
  await page.close();
});

test('the chosen speed is remembered', async () => {
  // Own context with the service worker blocked: a reload in a worker-controlled
  // page is served by the worker, which is a different code path from the one
  // this test is about. Reload behaviour has bitten this suite before.
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
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
  await page.addInitScript((d) => {
    localStorage.setItem('tripState_london-scotland',
      JSON.stringify({ tripType: 'solo', title: 'Test', days: d }));
    localStorage.setItem('tripFamily_london-scotland', '0');
  }, AUDIO_DAY);
  const ready = async () => {
    await page.waitForFunction(
      () => typeof state !== 'undefined' && state && Array.isArray(state.days), null, { timeout: 20000 });
    await page.evaluate(() => switchDay(0));
    await page.waitForFunction(
      () => document.querySelector('.audio-rate-btn'), null, { timeout: 20000 });
  };
  await page.goto(`${origin}/Travel/trip.html?id=london-scotland`, { waitUntil: 'domcontentloaded' });
  await ready();
  await page.evaluate(() => { document.querySelector('.audio-rate-btn').click(); });   // -> 1.25

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready();
  const out = await page.evaluate(() => ({
    label: document.querySelector('.audio-rate-btn').textContent,
    rate: document.querySelector('audio').playbackRate,
    stored: localStorage.getItem('seasons_audio_rate'),
  }));
  assert.equal(out.stored, '1.25', 'the preference is persisted');
  assert.equal(out.label, '1.25×', 'the setting survived a reload, got ' + out.label);
  assert.equal(out.rate, 1.25, 'and is applied to the player on load');
  await ctx.close();
});

test('the rate is re-applied on play, because iOS resets it', async () => {
  const { page } = await openTrip(AUDIO_DAY);
  await page.waitForFunction(
    () => document.querySelector('.audio-rate-btn'), null, { timeout: 15000 });
  const rate = await page.evaluate(() => {
    document.querySelector('.audio-rate-btn').click();          // -> 1.25
    const a = document.querySelector('audio');
    a.playbackRate = 1;                                          // what iOS does
    a.dispatchEvent(new Event('play'));
    return a.playbackRate;
  });
  assert.equal(rate, 1.25, 'the setting is restored rather than silently lost, got ' + rate);
  await page.close();
});

// ===========================================================================
// REAL TRAVEL TIMES. The estimate multiplies the straight line by a detour
// factor, which models a road bending but not network topology: Hampton Court
// to Windsor is 13 straight-line miles and about two hours by rail, because the
// line runs back through Clapham Junction. Looked-up times are stored on the
// arriving stop. Google is stubbed here — no key, no network, no cost.
// ===========================================================================
const RAIL_DAY = [
  { title: 'Day 3', subtitle: 'Thu, Aug 6, 2026', stops: [
    { name: 'Hampton Court Palace', type: 'hike', time: '10:00 AM', endTime: '12:00 PM',
      lat: 51.4036, lng: -0.3376 },
    { name: 'Windsor Castle', type: 'hike', time: '12:30 PM', endTime: '2:30 PM',
      lat: 51.4843, lng: -0.6048, transitMode: 'train' },
  ] },
];

// Stand in for the Maps SDK: records the requests and answers with a fixed leg.
async function stubGoogle(page, { mins = 118, miles = 27, fail = false, status = 'ZERO_RESULTS' } = {}) {
  await page.evaluate(({ mins, miles, fail, status }) => {
    localStorage.setItem('gp_key_london-scotland', 'TEST-KEY');
    window.__routeReqs = [];
    window.google = { maps: { DirectionsService: function () {
      this.route = (req, cb) => {
        window.__routeReqs.push(JSON.parse(JSON.stringify({
          travelMode: req.travelMode,
          hasTransitDepart: !!(req.transitOptions && req.transitOptions.departureTime),
          hasDriveDepart: !!(req.drivingOptions && req.drivingOptions.departureTime),
        })));
        if (fail) return cb(null, status);
        cb({ routes: [{ legs: [{ duration: { value: mins * 60 },
          distance: { value: Math.round(miles * 1609.344) } }] }] }, 'OK');
      };
    } } };
  }, { mins, miles, fail, status });
}

test('a looked-up time is stored on the arriving stop and beats the estimate', async () => {
  const { page } = await openTrip(RAIL_DAY);
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    const before = _legTravelMins(state.days[0].stops[0], state.days[0].stops[1]);
    await _fetchDayLegs(0);
    const s = state.days[0].stops[1];
    return { before, after: _legTravelMins(state.days[0].stops[0], s),
      mins: s.legMins, miles: s.legMiles, src: s.legSource, mode: s.legMode };
  });
  assert.ok(out.before < 60, 'the estimate was the optimistic one, got ' + out.before);
  assert.equal(out.mins, 118, 'the real time is stored');
  assert.equal(out.src, 'google');
  assert.equal(out.mode, 'train');
  assert.equal(out.after, 118, 'and every consumer now sees it, got ' + out.after);
  await page.close();
});

test('looking up times does NOT move any stop', async () => {
  const { page } = await openTrip(RAIL_DAY);
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    const before = state.days[0].stops.map((s) => s.time);
    await _fetchDayLegs(0);
    return { before, after: state.days[0].stops.map((s) => s.time) };
  });
  assert.deepEqual([...out.after], [...out.before],
    'a lookup must not reshuffle a live itinerary, got ' + JSON.stringify(out.after));
  await page.close();
});

test('a train leg asks for a departure time, because the timetable decides', async () => {
  const { page } = await openTrip(RAIL_DAY);
  await stubGoogle(page);
  const reqs = await page.evaluate(async () => { await _fetchDayLegs(0); return window.__routeReqs; });
  assert.equal(reqs.length, 1, 'one leg was requested');
  assert.equal(reqs[0].travelMode, 'TRANSIT', 'as transit, got ' + reqs[0].travelMode);
  assert.ok(reqs[0].hasTransitDepart, 'with a departure time');
  await page.close();
});

test('the leg says whether its number is routed or estimated', async () => {
  const { page } = await openTrip(RAIL_DAY);
  await page.waitForFunction(
    () => document.querySelector('.leg-connector'), null, { timeout: 15000 });
  const est = await page.evaluate(() => document.querySelector('.leg-connector').innerHTML);
  assert.match(est, /leg-est/, 'an estimate is labelled est.');
  await stubGoogle(page);
  const real = await page.evaluate(async () => {
    await _fetchDayLegs(0);
    return document.querySelector('.leg-connector').innerHTML;
  });
  assert.ok(!/leg-est/.test(real), 'a routed one carries no estimate marker');
  assert.ok(!/leg-real/.test(real), 'and no badge either — correct is the baseline, not an achievement');
  assert.match(real, /1h 58min/, 'showing the routed time, got: ' + real.replace(/<[^>]*>/g, ' '));
  await page.close();
});

test('applying is a separate, confirmed step that moves the stops', async () => {
  const { page } = await openTrip(RAIL_DAY);
  await stubGoogle(page);
  await page.evaluate(() => { window.confirm = () => true; });
  const out = await page.evaluate(async () => {
    await _fetchDayLegs(0);
    const before = state.days[0].stops[1].time;
    applyRealTimes(0);
    return { before, after: state.days[0].stops[1].time,
      log: _loadChangeLog().map((e) => e.desc) };
  });
  assert.equal(out.before, '12:30 PM', 'unmoved by the lookup');
  assert.equal(out.after, '1:58 PM', 'and moved to noon + 1h58 once applied, got ' + out.after);
  assert.ok(out.log.some((d) => /Applied real travel times/.test(d)), 'and it is recorded');
  await page.close();
});

test('a locked time is never moved by Apply', async () => {
  const locked = JSON.parse(JSON.stringify(RAIL_DAY));
  locked[0].stops[1].locked = true;
  const { page } = await openTrip(locked);
  await stubGoogle(page);
  await page.evaluate(() => { window.confirm = () => true; });
  const after = await page.evaluate(async () => {
    await _fetchDayLegs(0);
    applyRealTimes(0);
    return state.days[0].stops[1].time;
  });
  assert.equal(after, '12:30 PM', 'a reservation holds its slot, got ' + after);
  await page.close();
});

test('with no key nothing is fetched and the reason is given', async () => {
  const { page } = await openTrip(RAIL_DAY);
  const out = await page.evaluate(async () => {
    localStorage.removeItem('gp_key_london-scotland');
    const r = await _fetchDayLegs(0);
    return { r, src: state.days[0].stops[1].legSource,
      toast: (document.getElementById('share-toast') || {}).textContent || '' };
  });
  assert.ok(out.r.noKey, 'it stops before calling anything');
  assert.equal(out.src, undefined, 'and stores nothing');
  assert.match(out.toast, /Google API key/, 'and says what it needs: ' + out.toast);
  await page.close();
});

test('a failed lookup leaves the estimate alone', async () => {
  const { page } = await openTrip(RAIL_DAY);
  await stubGoogle(page, { fail: true });
  const out = await page.evaluate(async () => {
    const before = _legTravelMins(state.days[0].stops[0], state.days[0].stops[1]);
    const r = await _fetchDayLegs(0);
    return { r, before, after: _legTravelMins(state.days[0].stops[0], state.days[0].stops[1]),
      src: state.days[0].stops[1].legSource, again: _dayNeedsLegs(0) };
  });
  assert.equal(out.r.ok, 0, 'nothing came back');
  // ZERO_RESULTS means there genuinely is no such route, so it is remembered —
  // otherwise the day would be re-asked, and re-billed, on every single open.
  assert.equal(out.src, 'none', 'the dead end is remembered');
  assert.equal(out.again, false, 'so opening the day again asks nothing');
  assert.equal(out.after, out.before, 'and the estimate is untouched');
  await page.close();
});

test('a rejected key is reported as such, and the leg is left to retry', async () => {
  const { page } = await openTrip(RAIL_DAY);
  await stubGoogle(page, { fail: true, status: 'REQUEST_DENIED' });
  const out = await page.evaluate(async () => {
    const r = await _fetchDayLegs(0);
    return { r, src: state.days[0].stops[1].legSource, again: _dayNeedsLegs(0),
      toast: (document.getElementById('share-toast') || {}).textContent || '' };
  });
  assert.equal(out.r.error, 'REQUEST_DENIED');
  assert.match(out.toast, /Directions API/, 'it says what to fix, got: ' + out.toast);
  // A bad key is fixable. Marking these legs dead would mean fixing the key
  // never brought the real times back.
  assert.equal(out.src, undefined, 'nothing was written off');
  assert.equal(out.again, true, 'and they are tried again once the key works');
  await page.close();
});

// ===========================================================================
// v216 — REAL IS NOT A MODE. Routing was behind a per-day button, so a time was
// only correct if you asked for it. Opening a day now routes its legs, once.
// ===========================================================================
test('opening a day routes its legs without being asked', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 600));
    const s = state.days[0].stops[1];
    return { mins: s.legMins, src: s.legSource, reqs: window.__routeReqs.length };
  });
  assert.equal(out.src, 'google', 'the leg was routed with no button pressed');
  assert.equal(out.mins, 118);
  assert.equal(out.reqs, 1, 'exactly one lookup');
  await page.close();
});

test('there is no Real times button any more', async () => {
  const { page } = await openTrip(RAIL_DAY);
  const html = await page.evaluate(() => document.getElementById('content-area').innerHTML);
  assert.ok(!/Real times/.test(html), 'accuracy is not something you opt into');
  await page.close();
});

test('reopening a day routes nothing — it is cached', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page);
  const reqs = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 600));
    const first = window.__routeReqs.length;
    switchDay(-1); switchDay(0); switchDay(-1); switchDay(0);
    await new Promise((r) => setTimeout(r, 600));
    return { first, after: window.__routeReqs.length };
  });
  assert.equal(reqs.first, 1);
  assert.equal(reqs.after, 1, 'stored once, never fetched again, got ' + reqs.after);
  await page.close();
});

test('flicking between days cannot stack lookups', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page);
  const n = await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) switchDay(0);
    await new Promise((r) => setTimeout(r, 800));
    return window.__routeReqs.length;
  });
  assert.equal(n, 1, 'one in-flight pass per day, got ' + n);
  await page.close();
});

test('a leg with no route is not retried on every open', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page, { fail: true });
  const out = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 600));
    const first = window.__routeReqs.length;
    switchDay(-1); switchDay(0);
    await new Promise((r) => setTimeout(r, 600));
    return { first, after: window.__routeReqs.length, src: state.days[0].stops[1].legSource };
  });
  assert.equal(out.first, 1);
  assert.equal(out.src, 'none', 'the absence of a route is remembered');
  assert.equal(out.after, 1, 'and not asked again, got ' + out.after);
  await page.close();
});

test('routing on open never moves a stop', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    switchDay(0);
    const before = state.days[0].stops.map((s) => s.time);
    await new Promise((r) => setTimeout(r, 800));
    return { before, after: state.days[0].stops.map((s) => s.time) };
  });
  assert.deepEqual([...out.after], [...out.before], 'got ' + JSON.stringify(out.after));
  await page.close();
});

// ===========================================================================
// v218 — SILENCE IS THE BUG. v216 made the automatic path the only path and it
// passes {quiet:true}, which suppressed the failure report along with the
// success one. A rejected key, a disabled API and a working key all looked
// identical: nothing happened and nothing was said.
// ===========================================================================
async function toastText(page) {
  return page.evaluate(() => (document.getElementById('share-toast') || {}).textContent || '');
}

test('a failure on the AUTOMATIC path still reports the reason', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page, { fail: true, status: 'REQUEST_DENIED' });
  const out = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 800));
    return { toast: (document.getElementById('share-toast') || {}).textContent || '',
      status: _routingStatusText(0),
      html: document.getElementById('content-area').innerHTML };
  });
  assert.match(out.toast, /Directions API/, 'the quiet path still speaks up, got: ' + out.toast);
  assert.match(out.status, /Directions API/, 'and the reason stays on screen after the toast');
  assert.match(out.html, /Routing failed/, 'with a visible way back into it');
  await page.close();
});

test('each failure gets its own reason, not one generic message', async () => {
  const cases = [
    ['REQUEST_DENIED', /Directions API/],
    ['OVER_QUERY_LIMIT', /quota or billing/],
    ['NOT_FOUND', /could not place/],
  ];
  for (const [status, expect] of cases) {
    const { page } = await openTrip(RAIL_DAY);
    await stubGoogle(page, { fail: true, status });
    const toast = await page.evaluate(async () => {
      await _fetchDayLegs(0, { quiet: true });
      return (document.getElementById('share-toast') || {}).textContent || '';
    });
    assert.match(toast, expect, status + ' got: ' + toast);
    await page.close();
  }
});

test('a broken key reports once for the day, not once per leg', async () => {
  const THREE = [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
    { name: 'A', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 51.50, lng: -0.12 },
    { name: 'B', type: 'hike', time: '11:00 AM', endTime: '12:00 PM', lat: 51.52, lng: -0.16 },
    { name: 'C', type: 'hike', time: '1:00 PM', endTime: '2:00 PM', lat: 51.48, lng: -0.20 },
  ] }];
  const { page } = await openTrip(THREE);
  await stubGoogle(page, { fail: true, status: 'REQUEST_DENIED' });
  const out = await page.evaluate(async () => {
    let toasts = 0;
    const real = window.showToast;
    window.showToast = (...a) => { toasts++; return real.apply(null, a); };
    const r = await _fetchDayLegs(0, { quiet: true });
    return { toasts, reqs: (window.__routeReqs || []).length, fail: r.fail };
  });
  assert.equal(out.reqs, 2, 'both legs were attempted');
  assert.equal(out.fail, 2, 'and both failed');
  assert.equal(out.toasts, 1, 'but the user is told once, got ' + out.toasts);
  await page.close();
});

test('success on the automatic path stays silent', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 800));
    return { toast: (document.getElementById('share-toast') || {}).textContent || '',
      mins: state.days[0].stops[1].legMins, status: _routingStatusText(0) };
  });
  assert.equal(out.mins, 118, 'it worked');
  assert.equal(out.status, '', 'so there is nothing to explain');
  assert.doesNotMatch(out.toast, /Routing failed|Directions API/, 'and nothing to apologise for');
  await page.close();
});

test('the Maps script asks for no bogus library', async () => {
  const { page } = await openTrip(RAIL_DAY);
  const src = await page.evaluate(async () => {
    localStorage.setItem('gp_key_london-scotland', 'TEST-KEY');
    delete window.google;
    let captured = '';
    const realAppend = document.head.appendChild.bind(document.head);
    document.head.appendChild = (el) => {
      if (el.tagName === 'SCRIPT' && /maps\.googleapis/.test(el.src || '')) { captured = el.src; return el; }
      return realAppend(el);
    };
    _loadGoogleMaps().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    document.head.appendChild = realAppend;
    return captured;
  });
  assert.match(src, /maps\.googleapis\.com/, 'it is the Maps SDK, got: ' + src);
  // `libraries=routes` is not a value this loader takes; DirectionsService is core.
  assert.doesNotMatch(src, /libraries=/, 'and asks for no library at all, got: ' + src);
  await page.close();
});

test('gm_authFailure names both things to fix and stops the retry loop', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    window.gm_authFailure();
    const toast = (document.getElementById('share-toast') || {}).textContent || '';
    window.__routeReqs = [];
    switchDay(0);
    await new Promise((r) => setTimeout(r, 600));
    switchDay(-1);
    return { toast, reqs: window.__routeReqs.length, rejected: _keyRejected(),
      ov: document.getElementById('content-area').innerHTML };
  });
  assert.match(out.toast, /Directions API/);
  assert.match(out.toast, /Maps JavaScript API/, 'both APIs are named, got: ' + out.toast);
  assert.equal(out.rejected, true);
  assert.equal(out.reqs, 0, 'and it stops hammering Google with a key it knows is refused');
  assert.match(out.ov, /Google rejected this key/, 'the Overview says so plainly');
  await page.close();
});

test('a new key clears the rejection and lets routing work again', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    window.gm_authFailure();
    window.prompt = () => 'A-BETTER-KEY';
    promptGoogleKey();
    await new Promise((r) => setTimeout(r, 600));
    return { rejected: _keyRejected(), mins: state.days[0].stops[1].legMins };
  });
  assert.equal(out.rejected, false, 'the new key is not presumed broken');
  assert.equal(out.mins, 118, 'and the day it was entered on routes straight away');
  await page.close();
});

test('a key that is set but routes nothing is called out on the Overview', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page, { fail: true, status: 'REQUEST_DENIED' });
  const ov = await page.evaluate(async () => {
    await _fetchDayLegs(0, { quiet: true });
    switchDay(-1);
    return document.getElementById('content-area').innerHTML;
  });
  assert.match(ov, /Google would not route with it/, 'silence is not treated as success');
  assert.match(ov, /Routed 0 of 1 legs/);
  assert.match(ov, /Try again/, 'with something to do about it');
  await page.close();
});

// The opposite error: crying failure before anything has been attempted. Adding
// a key from the Overview must not immediately accuse it of being broken.
test('a freshly added key is not accused of failing before it has been tried', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  const ov = await page.evaluate(() => {
    localStorage.setItem('gp_key_london-scotland', 'TEST-KEY');
    switchDay(-1);
    return document.getElementById('content-area').innerHTML;
  });
  assert.doesNotMatch(ov, /would not route|rejected this key/, 'nothing has failed yet');
  await page.close();
});

// v216 shipped with ONE way to enter a key — a notice that hides itself forever
// once dismissed — and no key means nothing in the app is ever routed. Tapping
// "Not now" locked the feature away with no route back to it.
test('the way to add a key survives dismissing the notice', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  const out = await page.evaluate(() => {
    localStorage.removeItem('gp_key_london-scotland');
    switchDay(-1);
    dismissRoutingNotice();               // the notice is gone for good
    switchDay(-1);
    const ov = document.getElementById('content-area').innerHTML;
    switchDay(0);
    return { ov, day: document.getElementById('content-area').innerHTML,
      notice: !!document.getElementById('routing-key-notice') };
  });
  assert.equal(out.notice, false, 'the notice really is dismissed');
  assert.match(out.ov, /promptGoogleKey\(\)/, 'the Overview still offers a way in');
  assert.match(out.day, /promptGoogleKey\(\)/, 'and so does the day being read');
  await page.close();
});

test('a day with no key says so on the day itself, not just the Overview', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  const html = await page.evaluate(() => {
    localStorage.removeItem('gp_key_london-scotland');
    switchDay(0);
    return document.getElementById('content-area').innerHTML;
  });
  assert.match(html, /Times are estimates/, 'the day admits its numbers are guesses');
  await page.close();
});

test('once a key is set the day stops nagging and the button says so', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  const out = await page.evaluate(() => {
    localStorage.setItem('gp_key_london-scotland', 'TEST-KEY');
    switchDay(0);
    const day = document.getElementById('content-area').innerHTML;
    switchDay(-1);
    return { day, ov: document.getElementById('content-area').innerHTML };
  });
  assert.doesNotMatch(out.day, /Times are estimates/);
  assert.match(out.ov, /Key set/, 'and the Overview shows the key is in place');
  assert.doesNotMatch(out.ov, /routing-key-notice/, 'with no notice left to show');
  await page.close();
});

test('a key that cannot be stored is reported, never announced as saved', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  const out = await page.evaluate(() => {
    localStorage.removeItem('gp_key_london-scotland');
    const said = [];
    window.prompt = () => 'KEY-THAT-WONT-STICK';
    window.alert = (m) => said.push(String(m));
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith('gp_key_')) throw new Error('QuotaExceededError');
      return realSet.call(this, k, v);
    };
    try { promptGoogleKey(); } finally { Storage.prototype.setItem = realSet; }
    return { said, key: _gpKey() };
  });
  assert.equal(out.key, '', 'nothing was stored');
  assert.equal(out.said.length, 1, 'and the failure was not swallowed');
  assert.match(out.said[0], /could NOT be saved/i, 'got: ' + out.said[0]);
  await page.close();
});

test('with no key nothing is fetched and the leg stays marked as an estimate', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await page.evaluate(() => { localStorage.removeItem('gp_key_london-scotland'); window.__routeReqs = []; });
  const out = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 600));
    return { reqs: (window.__routeReqs || []).length, src: state.days[0].stops[1].legSource,
      html: document.querySelector('.leg-connector').innerHTML };
  });
  assert.equal(out.reqs, 0, 'nothing is attempted without a key');
  assert.equal(out.src, undefined);
  assert.match(out.html, /leg-est/, 'and the number is honestly marked as a guess');
  await page.close();
});

// THE BUG THAT GOT THROUGH. {noAutoFix:true} only protects the write that stores
// the real time. The time then LIVES on the itinerary, so the next save from
// anywhere — the opening-hours autofill, a checklist tick, a cloud sync — used to
// re-run the "push unreachable stops later" pass, see a 2-hour journey in a
// 30-minute gap, and quietly move Windsor to 1:58 PM. That is a day rearranging
// itself under someone standing in it.
test('a routed time never moves a stop on some LATER, unrelated save', async () => {
  const { page } = await openTrip(RAIL_DAY);
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    await _fetchDayLegs(0);
    const afterRouting = state.days[0].stops.map((s) => s.time);
    // Any ordinary save at all, with the auto-fix fully armed.
    state.days[0].stops[0].notes = 'touched';
    saveState('an unrelated edit');
    return { afterRouting, afterSave: state.days[0].stops.map((s) => s.time),
      real: _legTravelMins(state.days[0].stops[0], state.days[0].stops[1]) };
  });
  assert.equal(out.real, 118, 'the real time is still in force for display');
  assert.deepEqual([...out.afterSave], [...out.afterRouting],
    'but it moved nothing, got ' + JSON.stringify(out.afterSave));
  assert.equal(out.afterSave[1], '12:30 PM');
  await page.close();
});

test('stops that no longer fit are counted, not moved', async () => {
  const { page } = await openTrip(RAIL_DAY, { day: null });
  await stubGoogle(page);
  const out = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 800));
    return { n: _dayLegsNotFitting(0), time: state.days[0].stops[1].time,
      html: document.getElementById('content-area').innerHTML };
  });
  assert.equal(out.n, 1, 'the 30-minute gap cannot hold a 2-hour journey');
  assert.equal(out.time, '12:30 PM', 'but nothing moved on its own');
  assert.match(out.html, /need more travel time/, 'it is offered, not done');
  await page.close();
});

// ===========================================================================
// v219 — SWIPING DAYS. Real TouchEvents against the real listeners, because the
// bug was in how the listeners read a gesture, not in the arithmetic alone.
// ===========================================================================
const THREE_DAYS = [
  { title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
    { name: 'A', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 51.50, lng: -0.12 }] },
  { title: 'Day 2', subtitle: 'Thu, Aug 6, 2026', stops: [
    { name: 'B', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 51.52, lng: -0.16 }] },
  { title: 'Day 3', subtitle: 'Fri, Aug 7, 2026', stops: [
    { name: 'C', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 51.48, lng: -0.20 }] },
];

// Drive the app's own document listeners with genuine TouchEvents, moving in
// steps so the axis lock sees the gesture develop the way a finger does.
async function swipe(page, { dx, dy, ms = 250, steps = 8, selector = '.day-panel.active', fingers = 1 }) {
  await page.evaluate(async (g) => {
    const x0 = 200, y0 = 400;
    // RE-QUERY EVERY TIME. The app re-renders #content-area on its own (the
    // briefing and the hours fill both land mid-gesture), which detaches any
    // node held from before — and an event dispatched on a detached node never
    // reaches the document listeners, so the whole gesture silently vanishes.
    const at = () => document.querySelector(g.selector) || document.body;
    const fire = (type, x, y) => {
      const el = at();
      const mk = (tx, ty) => {
        const list = [new Touch({ identifier: 1, target: el, clientX: tx, clientY: ty })];
        if (g.fingers > 1) list.push(new Touch({ identifier: 2, target: el, clientX: tx + 60, clientY: ty }));
        return list;
      };
      const touches = mk(x, y);
      return el.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: type === 'touchmove',
        touches: type === 'touchend' ? [] : touches,
        targetTouches: type === 'touchend' ? [] : touches,
        changedTouches: touches,
      }));
    };
    fire('touchstart', x0, y0);
    for (let i = 1; i <= g.steps; i++) {
      await new Promise((r) => setTimeout(r, g.ms / g.steps));
      fire('touchmove', x0 + (g.dx * i) / g.steps, y0 + (g.dy * i) / g.steps);
    }
    fire('touchend', x0 + g.dx, y0 + g.dy);
  }, { dx, dy, ms, steps, selector, fingers });
  await page.waitForTimeout(60);
}

test('a small sideways move over a stop card does not change the day', async () => {
  const { page } = await openTrip(THREE_DAYS, { day: 1 });
  // The reported bug: reaching across to the side of a card paged the day.
  await swipe(page, { dx: -40, dy: 8, ms: 200 });
  assert.equal(await page.evaluate(() => currentDayIdx), 1,
    'reaching across a card must not throw you onto another day');
  await page.close();
});

test('scrolling a day with a sideways drift does not change the day', async () => {
  const { page } = await openTrip(THREE_DAYS, { day: 1 });
  await swipe(page, { dx: -35, dy: 240, ms: 400 });
  assert.equal(await page.evaluate(() => currentDayIdx), 1,
    'reading the stop list must not throw you onto another day');
  await page.close();
});

test('a deliberate flick still changes the day, both directions', async () => {
  const { page } = await openTrip(THREE_DAYS, { day: 1 });
  await swipe(page, { dx: -140, dy: 6, ms: 200 });
  assert.equal(await page.evaluate(() => currentDayIdx), 2, 'left goes forward');
  await swipe(page, { dx: 140, dy: 6, ms: 200 });
  assert.equal(await page.evaluate(() => currentDayIdx), 1, 'right goes back');
  await page.close();
});

test('a slow sideways drag while reading does not page', async () => {
  const { page } = await openTrip(THREE_DAYS, { day: 1 });
  await swipe(page, { dx: -160, dy: 10, ms: 1400, steps: 14 });
  assert.equal(await page.evaluate(() => currentDayIdx), 1);
  await page.close();
});

test('two fingers never page the day', async () => {
  const { page } = await openTrip(THREE_DAYS, { day: 1 });
  await swipe(page, { dx: -160, dy: 4, ms: 200, fingers: 2 });
  assert.equal(await page.evaluate(() => currentDayIdx), 1, 'a pinch is not a page turn');
  await page.close();
});

test('dragging the day tab bar scrolls it instead of paging', async () => {
  const { page } = await openTrip(THREE_DAYS, { day: 1 });
  // Force the tab strip to actually be scrollable, as it is on a phone.
  await page.evaluate(() => {
    const t = document.querySelector('.tabs');
    t.style.maxWidth = '120px'; t.style.overflowX = 'auto'; t.scrollLeft = 0;
  });
  await swipe(page, { dx: -140, dy: 4, ms: 200, selector: '.tabs' });
  assert.equal(await page.evaluate(() => currentDayIdx), 1,
    'the scroller gets the gesture, not the pager');
  await page.close();
});

test('the gesture is judged on how it started, not where it ended', async () => {
  const { page } = await openTrip(THREE_DAYS, { day: 1 });
  // Straight down first, then hard left: a scroll that changed its mind.
  await page.evaluate(async () => {
    const el = document.querySelector('.day-panel.active');
    const mk = (x, y) => [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })];
    const fire = (type, t) => el.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: type === 'touchmove',
      touches: type === 'touchend' ? [] : t, targetTouches: type === 'touchend' ? [] : t,
      changedTouches: t,
    }));
    fire('touchstart', mk(300, 500));
    for (let i = 1; i <= 5; i++) { await new Promise((r) => setTimeout(r, 20)); fire('touchmove', mk(300, 500 + i * 20)); }
    for (let i = 1; i <= 5; i++) { await new Promise((r) => setTimeout(r, 20)); fire('touchmove', mk(300 - i * 40, 604)); }
    fire('touchend', mk(100, 604));
  });
  await page.waitForTimeout(60);
  assert.equal(await page.evaluate(() => currentDayIdx), 1,
    'once it locks vertical it stays vertical');
  await page.close();
});


// ===========================================================================
// v220 — WEATHER. It was wrong by ~20°: the hourly strip picked which hours to
// show using the iPad's clock against Britain's hours, and the briefing's
// weather was frozen inside a cached AI narrative that the model was told to
// invent when no reading was available.
// ===========================================================================
const WX_DAY = [{ title: 'Day 1', subtitle: 'Wed, Aug 5, 2026', stops: [
  { name: 'Glenfinnan', type: 'hike', time: '6:00 PM', endTime: '7:00 PM', lat: 56.8758, lng: -5.431 },
] }];

// Answer Open-Meteo with temperature == hour, so reading the wrong hour is
// unmistakable in the assertion rather than merely "a bit off".
async function stubWeather(page, { offset = 3600, base = 0, fail = false } = {}) {
  await page.evaluate(({ offset, base, fail }) => {
    window.__wxCalls = [];
    const real = window.fetch;
    window.fetch = async (u, o) => {
      const url = String(u && u.url ? u.url : u);
      if (!/open-meteo/.test(url)) return real ? real(u, o) : { ok: true, json: async () => ({}) };
      window.__wxCalls.push(url);
      if (fail) return { ok: false, status: 500, json: async () => ({}) };
      const times = [], temps = [];
      for (let h = 0; h < 24; h++) {
        times.push('2026-08-05T' + String(h).padStart(2, '0') + ':00');
        temps.push(base + h);
      }
      return { ok: true, json: async () => ({
        hourly: { time: times, temperature_2m: temps, weathercode: times.map(() => 0),
          precipitation_probability: times.map(() => 0) },
        daily: { temperature_2m_max: [23], temperature_2m_min: [12], weathercode: [0] },
        utc_offset_seconds: offset,
      }) };
    };
  }, { offset, base, fail });
}

test('the hourly strip uses the destination clock, not the device clock', async () => {
  // Device pinned to New York; the destination is Britain, hours ahead.
  const { page } = await openTrip(WX_DAY, { day: null, timezoneId: 'America/New_York' });
  await stubWeather(page, { offset: 3600 });
  const out = await page.evaluate(async () => {
    const series = await _wxHourly(56.8758, -5.431, '2026-08-05');
    return { destH: Math.floor(_destNowMins(series) / 60),
      deviceH: new Date().getHours(),
      expectH: new Date(Date.now() + 3600 * 1000).getUTCHours() };
  });
  assert.equal(out.destH, out.expectH, 'the hour comes from the API offset');
  assert.notEqual(out.destH, out.deviceH,
    'and genuinely differs from this device, so the test can prove something');
  await page.close();
});

test('the reading is the one for the hour you are at that stop', async () => {
  const { page } = await openTrip(WX_DAY, { day: null });
  await stubWeather(page);
  const out = await page.evaluate(async () => {
    const s = await _wxHourly(56.8758, -5.431, '2026-08-05');
    return { six: _wxAtHour(s, 18 * 60), eight: _wxAtHour(s, 8 * 60) };
  });
  assert.equal(out.six.c, 18, 'the 6pm stop gets the 6pm temperature');
  assert.equal(out.six.f, 64, 'in both units');
  assert.equal(out.eight.c, 8, 'not one figure smeared over the whole day');
  await page.close();
});

test('the briefing weather is refetched, never served from the cached text', async () => {
  const { page } = await openTrip(WX_DAY, { day: null });
  await stubWeather(page, { base: 0 });
  const first = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 700));
    return document.getElementById('day-narr-wx-0').textContent;
  });
  assert.match(first, /23°C/, 'the real high is shown, got: ' + first);
  // The world changes; the cached prose must not carry yesterday's numbers.
  const second = await page.evaluate(async () => {
    window.__wxCalls = [];
    const real = window.fetch;
    window.fetch = async (u, o) => {
      const url = String(u && u.url ? u.url : u);
      if (!/open-meteo/.test(url)) return real(u, o);
      const times = [], temps = [];
      for (let h = 0; h < 24; h++) { times.push('2026-08-05T' + String(h).padStart(2, '0') + ':00'); temps.push(h); }
      return { ok: true, json: async () => ({
        hourly: { time: times, temperature_2m: temps, weathercode: times.map(() => 0),
          precipitation_probability: times.map(() => 0) },
        daily: { temperature_2m_max: [4], temperature_2m_min: [1], weathercode: [0] },
        utc_offset_seconds: 3600 }) };
    };
    Object.keys(_WX_CACHE).forEach((k) => delete _WX_CACHE[k]);   // as a later day would
    await _paintDayWeather(0);
    return document.getElementById('day-narr-wx-0').textContent;
  });
  assert.match(second, /4°C/, 'the new reading replaces the old one, got: ' + second);
  assert.doesNotMatch(second, /23°C/, 'nothing stale survives');
  await page.close();
});

test('nothing sent to the model asks it for weather', async () => {
  const { page } = await openTrip(WX_DAY, { day: null });
  await stubWeather(page);
  // captureAiRequest deliberately ignores the briefing call as background noise,
  // so watch the wire directly — this test is precisely about that call.
  await page.evaluate(() => {
    window.__ai = [];
    const real = window.fetch;
    window.fetch = async (u, o) => {
      const url = String(u && u.url ? u.url : u);
      let parsed = null;
      try { parsed = JSON.parse(o && o.body); } catch (e) { /* not JSON */ }
      if (parsed && typeof parsed.system === 'string') {
        window.__ai.push(parsed);
        return { ok: true, json: async () => ({ content: [{ text: 'A fine day in the glen.' }] }) };
      }
      return real(u, o);
    };
  });
  const sent = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 900));
    return window.__ai;
  });
  assert.ok(sent.length, 'the briefing was requested');
  for (const b of sent) {
    assert.doesNotMatch(b.system + ' ' + b.user, /estimate typical weather/i,
      'the model is never asked to make up the weather');
    assert.doesNotMatch(b.user, /°F|°C/, 'and is given no temperature to echo');
  }
  await page.close();
});

test('when the weather cannot be loaded it says so rather than vanishing', async () => {
  const { page } = await openTrip(WX_DAY, { day: null });
  await stubWeather(page, { fail: true });
  const out = await page.evaluate(async () => {
    switchDay(0);
    await new Promise((r) => setTimeout(r, 700));
    const el = document.getElementById('day-narr-wx-0');
    return { text: el.textContent, wx: _wxDayCache[0] };
  });
  assert.match(out.text, /unavailable/i, 'got: ' + out.text);
  assert.doesNotMatch(out.text, /\d+°/, 'and invents no number to fill the gap');
  assert.equal(out.wx.unavailable, true);
  await page.close();
});

test('a briefing cached with a weather line baked in is stripped of it', async () => {
  const { page } = await openTrip(WX_DAY, { day: null });
  const out = await page.evaluate(() => {
    narrData['x|2026-08-05'] = '⛅ Partly cloudy · High 23°C / 74°F · Climate Avg\nToday you walk the glen.';
    localStorage.setItem(NARR_LS, JSON.stringify(narrData));
    _purgeStaleWeatherNarratives();
    return narrData['x|2026-08-05'];
  });
  assert.equal(out, 'Today you walk the glen.', 'the prose is kept, the invented weather is not');
  await page.close();
});
