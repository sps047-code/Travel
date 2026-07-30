// ============================================================================
// Characterization tests for the LIVE app's core math. Loads the real trip.js
// in a stubbed sandbox and exercises its ACTUAL functions — no app changes.
// This is the safety net that locks the signature bugs (2 AM cascade wrap,
// coordinate-driven distances, duration = end - start) against regression.
//
// Run: node --test tests/            (no dependencies)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let src = fs.readFileSync(path.join(dir, '..', 'trip.js'), 'utf8');

// Minimal, behaviour-preserving transforms so we can drive the functions:
//  - make `state` a global (var) so a fixture can be injected;
//  - neutralise the bootstrap (init + service-worker) so no async DOM code runs.
src = src.replace('let state,currentDayIdx', 'var state,currentDayIdx');
src = src.replace(/\binit\(\);/g, ';');
src = src.replace(/if\('serviceWorker' in navigator\)\{[^}]*\}/g, ';');

// ---- Browser stubs (just enough for top-level evaluation) -------------------
const noop = () => {};
const el = () => ({
  style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, removeEventListener: noop, appendChild: (x) => x, removeChild: (x) => x,
  insertBefore: (x) => x, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus: noop, remove: noop,
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  innerHTML: '', textContent: '', value: '', checked: false, children: [], childNodes: [],
  offsetHeight: 0, offsetWidth: 0, clientWidth: 0, scrollWidth: 0, id: '',
});
const layer = {};
for (const m of ['addTo', 'addLayer', 'clearLayers', 'removeLayer', 'bindPopup', 'openPopup',
  'on', 'off', 'setView', 'fitBounds', 'remove', 'setLatLng', 'getBounds', 'eachLayer',
  'setStyle', 'redraw', 'invalidateSize', 'hasLayer', 'bringToFront', 'setZIndex']) layer[m] = () => layer;
const L = new Proxy({}, { get: () => () => layer });

const store = new Map();
const sandbox = {
  console, Math, JSON, Date, URLSearchParams, Intl, Promise, Object, Array, Number, String, RegExp,
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: () => 0, queueMicrotask: noop,
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  location: { search: '?id=london-scotland', pathname: '/Travel/trip.html', href: 'https://x/Travel/trip.html', origin: 'https://x', reload: noop },
  navigator: { serviceWorker: { register: async () => ({}), addEventListener: noop }, onLine: true, userAgent: 'node' },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
  alert: noop, confirm: () => true, prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, scrollTo: noop,
  getComputedStyle: () => ({}), innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  L,
  document: {
    getElementById: el, createElement: el, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop, body: el(), documentElement: el(), head: el(), title: '',
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
process.on('unhandledRejection', noop);

const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'trip.js' });

// Convenience: pull a function off the evaluated context.
const fn = (name) => {
  const f = ctx[name];
  assert.equal(typeof f, 'function', `expected ${name} to be a function on the live app`);
  return f;
};

// ---------------------------------------------------------------------------
test('_parseTimeMins parses clock times and rejects durations', () => {
  const p = fn('_parseTimeMins');
  assert.equal(p('9:30 AM'), 9 * 60 + 30);
  assert.equal(p('12:08PM'), 12 * 60 + 8);
  assert.equal(p('12:00 AM'), 0);
});

test('duration is derived from times (25 min, not a stale value)', () => {
  const p = fn('_parseTimeMins');
  const fmt = fn('_fmtDur');
  const span = p('12:33PM') - p('12:08PM');
  assert.equal(fmt(span), '25min');
});

test('haversine: Rosslyn -> Glenfinnan is ~112 mi (never 20)', () => {
  const h = fn('haversine');
  const d = h(55.8553, -3.16, 56.8758, -5.431);
  assert.ok(d > 100 && d < 125, `expected ~112, got ${d}`);
});

test('_recalcDayTimes never lands a stop in the small hours (2:26 AM bug)', () => {
  const recalc = fn('_recalcDayTimes');
  const parse = fn('_parseTimeMins');
  ctx.state = {
    days: [{
      stops: [
        { name: 'Lunch', type: 'food', time: '12:00 PM', endTime: '12:45 PM', lat: 55.95, lng: -3.19, duration: '45min' },
        // A corrupt coordinate on the far side of the planet.
        { name: 'Corrupt', type: 'hike', lat: -40, lng: 175 },
        { name: 'Dinner', type: 'food', lat: 55.96, lng: -3.18 },
      ],
    }],
  };
  recalc(0);
  for (const s of ctx.state.days[0].stops) {
    const m = parse(s.time);
    assert.ok(m !== null, `stop ${s.name} lost its time`);
    assert.ok(m >= 4 * 60, `stop ${s.name} at ${s.time} is in the small hours`);
    assert.ok(m <= 23 * 60 + 45, `stop ${s.name} at ${s.time} crossed midnight`);
  }
});

test('_logicErrors: the REAL Day 7 is feasible → no errors (must not false-positive)', () => {
  const le = fn('_logicErrors');
  const st = { days: [{ stops: [
    { name: 'Stirling Castle', type: 'hike', time: '9:30 AM', endTime: '11:00 AM', lat: 56.1237, lng: -3.948 },
    { name: 'Lunch — Settle Inn', type: 'food', time: '11:15 AM', endTime: '11:45 AM', lat: 56.12, lng: -3.94 },
    { name: 'Drive — Stirling to Glenfinnan', type: 'drive', time: '11:45 AM', lat: 56.8758, lng: -5.431 },
    { name: 'Glenfinnan Viaduct', type: 'hike', time: '1:20 PM', lat: 56.8758, lng: -5.431 },
    { name: 'Glencoe', type: 'hike', time: '3:30 PM', lat: 56.6779, lng: -5.0974 },
    { name: 'Café Gandolfi', type: 'food', time: '8:00 PM', lat: 55.8578, lng: -4.2445 },
  ] }] };
  assert.equal(le(st).length, 0, 'feasible Day 7 wrongly flagged: ' + JSON.stringify(le(st)));
});

test('_logicErrors: 77 mi with only 15 min → blocked as Impossible travel', () => {
  const le = fn('_logicErrors');
  const st = { days: [{ stops: [
    { name: 'Lunch', type: 'food', time: '12:00 PM', endTime: '12:45 PM', lat: 56.12, lng: -3.94 },
    { name: 'Glenfinnan', type: 'hike', time: '1:00 PM', lat: 56.8758, lng: -5.431 },
  ] }] };
  const errs = le(st);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].rule, 'Impossible travel');
});

test('_logicErrors: a 45-min stop ending 5:15 cannot reach Glasgow by 5:30', () => {
  const le = fn('_logicErrors');
  const st = { days: [{ stops: [
    // ~28 mi apart, matching the real stops; a 45-min visit from 4:30 departs 5:15,
    // and 28 mi cannot be covered in the 15 min before a 5:30 arrival even at top speed.
    { name: 'Highland Cattle & Loch Lomond', type: 'hike', time: '4:30 PM', duration: '45min', lat: 56.20, lng: -4.65 },
    { name: 'Glasgow City Walk', type: 'hike', time: '5:30 PM', lat: 55.8609, lng: -4.2514 },
  ] }] };
  const errs = le(st);
  assert.ok(errs.some((e) => e.rule === 'Impossible travel'),
    'must flag 4:30 PM + 45min visit → 5:30 PM arrival: ' + JSON.stringify(errs));
});

test('_logicErrors: stops out of time order are flagged', () => {
  const le = fn('_logicErrors');
  const st = { days: [{ stops: [
    { name: 'A', type: 'sight', time: '2:00 PM', lat: 56.1, lng: -3.9 },
    { name: 'B', type: 'sight', time: '10:00 AM', lat: 56.1, lng: -3.9 },
  ] }] };
  assert.ok(le(st).some((e) => e.rule === 'Out of order'));
});

test('saveState GATE: auto-fits by shrinking a visit, then persists (with a warning)', () => {
  const save = fn('saveState');
  const seed = fn('_seedLogicBaseline');
  const p = fn('_parseTimeMins');
  ctx.state = { tripType: 'solo', days: [{ stops: [
    { name: 'Lunch', type: 'food', time: '12:00 PM', endTime: '12:45 PM', lat: 56.12, lng: -3.94 },
    { name: 'Glenfinnan', type: 'hike', time: '3:00 PM', lat: 56.8758, lng: -5.431 },
  ] }] };
  seed();
  let persisted = null;
  ctx.localStorage.setItem = (k, v) => { persisted = v; };
  // Pull Glenfinnan to 1:00 PM — 77 mi needs ~51 min, so Lunch must shrink to ~9 min.
  ctx.state.days[0].stops[1].time = '1:00 PM';
  save();
  assert.ok(persisted, 'a fixable change should be SAVED (not refused)');
  const lunch = ctx.state.days[0].stops[0];
  const visit = p(lunch.endTime) - p(lunch.time);
  assert.ok(visit >= 0 && visit < 45, 'Lunch visit was shortened to fit, got ' + visit + ' min');
});

test('saveState GATE: refuses ONLY when travel alone cannot fit (visit would be < 0)', () => {
  const save = fn('saveState');
  const seed = fn('_seedLogicBaseline');
  ctx.state = { tripType: 'solo', days: [{ stops: [
    { name: 'Lunch', type: 'food', time: '12:00 PM', endTime: '12:45 PM', lat: 56.12, lng: -3.94 },
    { name: 'Glenfinnan', type: 'hike', time: '3:00 PM', lat: 56.8758, lng: -5.431 },
  ] }] };
  seed();
  let persisted = null;
  ctx.localStorage.setItem = (k, v) => { persisted = v; };
  let alerted = '';
  ctx.alert = (m) => { alerted = m; };
  // Glenfinnan at 12:15 — 77 mi needs ~51 min even with a zero-length lunch. Impossible.
  ctx.state.days[0].stops[1].time = '12:15 PM';
  save();
  assert.equal(persisted, null, 'a truly impossible itinerary must NOT be written');
  assert.match(alerted, /physical world|Impossible/, 'user is told it cannot be done');
});

test('renderPanel draws NO travel-distance leg into a drive stop (kills 77mi/0min)', () => {
  const renderPanel = fn('renderPanel');
  ctx.currentDayIdx = 0;
  ctx.state = { title: 'Scotland', days: [{ title: 'Day 7', subtitle: 'Mon Aug 10 2026', stops: [
    { name: 'Stirling Castle', type: 'hike', time: '9:30 AM', endTime: '11:00 AM', lat: 56.1237, lng: -3.948 },
    { name: 'Lunch — Settle Inn', type: 'food', time: '11:15 AM', endTime: '11:45 AM', lat: 56.12, lng: -3.94 },
    { name: 'Drive — Stirling to Glenfinnan', type: 'drive', time: '11:45 AM', duration: '1h 45min', lat: 56.8758, lng: -5.431 },
    { name: 'Glenfinnan Viaduct', type: 'hike', time: '1:20 PM', lat: 56.8758, lng: -5.431 },
    { name: 'Glencoe', type: 'hike', time: '3:30 PM', lat: 56.6779, lng: -5.0974 },
  ] }] };
  const html = renderPanel(0);
  // Before the fix, a "77 mi" leg was drawn into the Drive stop while its start
  // sat 0 min after lunch — the "77 mi in 0 min" nonsense. It must be gone.
  assert.ok(!/77\s*mi/.test(html), 'a 77 mi leg is still drawn into the drive stop');
});

test('_fixScotlandDay7Once replaces the corrupted Day 7 once, feasibly', () => {
  const fixOnce = fn('_fixScotlandDay7Once');
  const le = fn('_logicErrors');
  ctx.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
  ctx.state = { tripType: 'family', days: [
    { title: 'Day 6', stops: [{ name: 'Somewhere', type: 'hike', time: '9:00 AM', lat: 55.9, lng: -3.2 }] },
    { title: 'Day 7', stops: [
      // Infeasible: ~112 mi apart (Edinburgh to the NW Highlands) with only 15 min between them.
      { name: 'Rosslyn Chapel', type: 'food', time: '9:30 AM', lat: 55.8553, lng: -3.16 },
      { name: 'Glenfinnan Viaduct', type: 'hike', time: '9:45 AM', lat: 56.8758, lng: -5.431 },
    ] },
  ] };
  assert.equal(fixOnce(), true, 'should replace the infeasible Day 7');
  const d7 = ctx.state.days[1];
  assert.equal(d7.stops[0].name, 'Stirling Castle');
  assert.equal(d7.stops.length, 8);
  assert.equal(le(ctx.state).length, 0, 'corrected trip must be feasible: ' + JSON.stringify(le(ctx.state)));
  ctx.localStorage.setItem('day7_corrected_v1', '1');
  assert.equal(fixOnce(), false, 'must never run a second time');
});

test('_fixScotlandDay7Once cleans a stale "Rosslyn" title when stops are already feasible', () => {
  const fixOnce = fn('_fixScotlandDay7Once');
  ctx.state = { tripType: 'family', days: [{
    title: 'Rosslyn, Glenfinnan & Glencoe',
    subtitle: 'Mon, Aug 10, 2026 · Rosslyn Chapel · Glenfinnan Viaduct · Glencoe',
    stops: [
      { name: 'Stirling Castle', type: 'hike', time: '9:30 AM', endTime: '10:45 AM', lat: 56.1237, lng: -3.948 },
      { name: 'Glenfinnan Viaduct', type: 'hike', time: '1:20 PM', endTime: '2:20 PM', lat: 56.8758, lng: -5.431 },
    ],
  }] };
  assert.equal(fixOnce(), true, 'should clean the stale title');
  assert.ok(!/rosslyn/i.test(ctx.state.days[0].title), 'title still names Rosslyn: ' + ctx.state.days[0].title);
  assert.ok(!/rosslyn/i.test(ctx.state.days[0].subtitle), 'subtitle still names Rosslyn: ' + ctx.state.days[0].subtitle);
});

test('fetchDayWeather never shows 0°F when the API has no reading', async () => {
  const fdw = fn('fetchDayWeather');
  // Simulate the forecast API returning a row with NO temperature (the 0°F bug).
  ctx.fetch = async () => ({ ok: true, json: async () => ({ daily: {
    temperature_2m_max: [null], temperature_2m_min: [null], weathercode: [null],
    precipitation_probability_max: [null], precipitation_sum: [null],
  } }) });
  const day = { subtitle: 'Mon, Aug 10, 2026 · Glenfinnan', stops: [{ name: 'Glenfinnan', lat: 56.8758, lng: -5.431 }] };
  const wx = await fdw(day);
  assert.ok(wx, 'should return a weather object');
  assert.notEqual(wx.hi, 0, 'must never display 0°F');
  assert.equal(wx.wxType, 'climateAvg', 'a missing reading falls back to the climate-avg estimate');
});

test('moving a stop never sends the first stop past midnight (untimed first stop)', () => {
  const move = fn('moveStop');
  const p = fn('_parseTimeMins');
  ctx.renderAll = () => {}; ctx.renderDayMap = () => {}; ctx.alert = () => {};
  ctx.state = { tripType: 'solo', days: [{ title: 'D', stops: [
    { name: 'A', type: 'hike', lat: 56.12, lng: -3.94 },                                  // untimed first stop
    { name: 'B', type: 'food', time: '12:00 PM', endTime: '12:45 PM', lat: 56.4, lng: -4.7 },
    { name: 'C', type: 'hike', time: '3:00 PM', endTime: '4:00 PM', lat: 56.8, lng: -5.4 },
  ] }] };
  move(0, 2, -1); // move C up
  const first = p(ctx.state.days[0].stops[0].time);
  assert.ok(first >= 240, 'first stop must be at/after 4 AM, got ' + ctx.state.days[0].stops[0].time);
});

test('_recalcDayTimes clamps an absurd sub-4AM anchor to a sane morning', () => {
  const recalc = fn('_recalcDayTimes');
  const p = fn('_parseTimeMins');
  ctx.state = { days: [{ stops: [
    { name: 'A', type: 'hike', lat: 56.12, lng: -3.94 },
    { name: 'B', type: 'hike', time: '2:00 PM', lat: 56.8, lng: -5.4 },
  ] }] };
  recalc(0, 5); // 5 minutes past midnight — absurd
  assert.ok(p(ctx.state.days[0].stops[0].time) >= 240, 'first stop clamped to >= 4 AM');
});

test('bike is a supported travel mode (~12 mph)', () => {
  const tm = fn('_travelMins');
  const t = tm(6, 'bike');
  assert.ok(t >= 25 && t <= 35, 'bike 6 mi should be ~30 min, got ' + t);
});

test('_healBadEndTimes makes duration equal end - start for an activity', () => {
  const heal = fn('_healBadEndTimes');
  const state = { days: [{ stops: [{ name: 'Cafe', type: 'food', time: '12:08 PM', endTime: '12:33 PM', duration: '45min' }] }] };
  ctx.state = state;
  heal();
  assert.equal(state.days[0].stops[0].duration, '25min');
});
