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

// REGRESSION GUARD (second data-loss incident): _fixScotlandDay7Once used to
// REPLACE the user's entire, hand-tuned Day 7 with a hardcoded array whenever
// that day was infeasible — destroying weeks of work on load and pushing the
// stale copy to the shared cloud. It is now a permanent no-op. These tests lock
// in that it can NEVER mutate a user's stops, however infeasible the day is.
test('_fixScotlandDay7Once never replaces an infeasible Day 7 (no destructive auto-heal)', () => {
  const fixOnce = fn('_fixScotlandDay7Once');
  ctx.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
  const infeasible = [
    // Infeasible: ~112 mi apart (Edinburgh to the NW Highlands) with only 15 min between them.
    { name: 'Rosslyn Chapel', type: 'food', time: '9:30 AM', lat: 55.8553, lng: -3.16 },
    { name: 'Glenfinnan Viaduct', type: 'hike', time: '9:45 AM', lat: 56.8758, lng: -5.431 },
  ];
  ctx.state = { tripType: 'family', days: [
    { title: 'Day 6', stops: [{ name: 'Somewhere', type: 'hike', time: '9:00 AM', lat: 55.9, lng: -3.2 }] },
    { title: 'Day 7', stops: infeasible },
  ] };
  const before = JSON.stringify(ctx.state.days[1].stops);
  assert.equal(fixOnce(), false, 'must report no change — it must never mutate');
  assert.equal(JSON.stringify(ctx.state.days[1].stops), before, 'user stops must be left EXACTLY as-is, never replaced');
  assert.equal(ctx.state.days[1].stops.length, 2, 'the two user stops must survive');
  assert.equal(ctx.state.days[1].stops[0].name, 'Rosslyn Chapel', 'user stop name must not be overwritten');
});

test('_fixScotlandDay7Once never touches title/subtitle (no auto-mutation on load)', () => {
  const fixOnce = fn('_fixScotlandDay7Once');
  ctx.state = { tripType: 'family', days: [{
    title: 'Rosslyn, Glenfinnan & Glencoe',
    subtitle: 'Mon, Aug 10, 2026 · Rosslyn Chapel · Glenfinnan Viaduct · Glencoe',
    stops: [
      { name: 'Stirling Castle', type: 'hike', time: '9:30 AM', endTime: '10:45 AM', lat: 56.1237, lng: -3.948 },
      { name: 'Glenfinnan Viaduct', type: 'hike', time: '1:20 PM', endTime: '2:20 PM', lat: 56.8758, lng: -5.431 },
    ],
  }] };
  const before = JSON.stringify(ctx.state.days[0]);
  assert.equal(fixOnce(), false, 'must report no change');
  assert.equal(JSON.stringify(ctx.state.days[0]), before, 'nothing on the day may be mutated — heading heal is _syncDayHeadings\' job');
});

test('_syncDayHeadings rebuilds a stale day heading from the live stops', () => {
  const sync = fn('_syncDayHeadings');
  ctx.state = { days: [{
    title: 'Rosslyn, Glenfinnan & Glencoe',
    subtitle: 'Mon, Aug 10, 2026 · Rosslyn Chapel · Glenfinnan Viaduct · Glencoe',
    stops: [
      { name: 'Stirling Castle', type: 'sight', time: '9:30 AM' },
      { name: 'Glenfinnan Viaduct', type: 'hike', time: '1:20 PM' },
      { name: 'Glencoe', type: 'hike', time: '3:15 PM' },
    ],
  }] };
  sync();
  const d = ctx.state.days[0];
  assert.ok(!/rosslyn/i.test(d.title), 'stale title: ' + d.title);
  assert.ok(!/rosslyn/i.test(d.subtitle), 'stale subtitle: ' + d.subtitle);
  assert.ok(/stirling/i.test(d.title), 'title reflects live stops: ' + d.title);
  assert.ok(/aug 10, 2026/i.test(d.subtitle), 'subtitle keeps the date: ' + d.subtitle);
});

test('_scrubRemovedStop strips the removed stop from heading and other notes', () => {
  const scrub = fn('_scrubRemovedStop');
  ctx.state = { days: [{
    title: 'Bourton-on-the-Water & Blenheim',
    subtitle: 'Fri, Aug 5, 2026 · Bourton-on-the-Water · Blenheim Palace',
    stops: [
      { name: 'Blenheim Palace', type: 'sight', notes: 'Grand palace. Then drive to Bourton-on-the-Water for lunch. Beautiful gardens.' },
    ],
  }] };
  scrub(0, 'Bourton-on-the-Water');
  const d = ctx.state.days[0];
  assert.ok(!/bourton/i.test(d.title), 'title: ' + d.title);
  assert.ok(!/bourton/i.test(d.subtitle), 'subtitle: ' + d.subtitle);
  assert.ok(!/bourton/i.test(d.stops[0].notes), 'notes: ' + d.stops[0].notes);
  assert.ok(/blenheim/i.test(d.title), 'kept Blenheim: ' + d.title);
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

// ---------------------------------------------------------------------------
// DATA-LOSS SAFEGUARDS (added after the June-14 overwrite incident).
// These lock in that a stale/empty/default copy can never clobber real work.
test('_wouldLoseData blocks overwriting a full trip with an empty one', () => {
  const g = fn('_wouldLoseData');
  const full = { days: Array.from({ length: 11 }, () => ({ stops: [{ name: 'x' }, { name: 'y' }, { name: 'z' }] })) };
  assert.equal(g(full, { days: [] }), true, 'empty next must be blocked');
  assert.equal(g(full, { days: null }), true, 'non-trip next must be blocked');
  assert.equal(g(full, {}), true, 'missing days must be blocked');
});

test('_wouldLoseData blocks catastrophic loss but ALLOWS deleting a day', () => {
  const g = fn('_wouldLoseData');
  const full = { days: Array.from({ length: 11 }, () => ({ stops: [{ name: 'x' }, { name: 'y' }, { name: 'z' }] })) };
  const halfStops = { days: Array.from({ length: 11 }, () => ({ stops: [{ name: 'x' }] })) };
  assert.equal(g(full, halfStops), true, 'losing more than half the stops must be blocked');
  // Deleting a day is a legitimate edit. Blocking it froze syncing permanently,
  // because a blocked push is dropped and never retried.
  const fewerDays = { days: Array.from({ length: 10 }, () => ({ stops: [{ name: 'x' }, { name: 'y' }, { name: 'z' }] })) };
  assert.equal(g(full, fewerDays), false, 'deleting one day must still sync');
});

test('_wouldLoseData allows a normal edit (same size or minor change)', () => {
  const g = fn('_wouldLoseData');
  const full = { days: Array.from({ length: 11 }, () => ({ stops: [{ name: 'x' }, { name: 'y' }, { name: 'z' }] })) };
  const edited = JSON.parse(JSON.stringify(full));
  edited.days[0].stops.pop(); // remove one stop out of 33 — normal
  assert.equal(g(full, edited), false, 'a normal one-stop edit must be allowed');
  assert.equal(g(null, full), false, 'no previous trip means nothing to lose');
});

test('cloud version history exists, keeps 5, and is weekly', () => {
  // Backups live in the cloud (see _dbBackupBeforeOverwrite), not on the device.
  assert.equal(typeof ctx._dbBackupBeforeOverwrite, 'function', '_dbBackupBeforeOverwrite must exist');
  assert.match(src, /const BACKUP_KEEP=5/, 'the cloud history must retain exactly 5 versions');
  const due = fn('_isBackupDue');
  const now = 1_000 * 60 * 60 * 24 * 400; // arbitrary fixed ms
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  assert.equal(due(0, now), true, 'a first backup is always due');
  assert.equal(due(now - WEEK - 1, now), true, 'due once the newest is a week old');
  assert.equal(due(now - (WEEK - 1000), now), false, 'not due if the newest is under a week old');
});

// ---------------------------------------------------------------------------
// Airport arrival: 3 hrs early for international, 2 hrs for domestic.
test('_minsToClock formats minutes-since-midnight as a clock time', () => {
  const c = fn('_minsToClock');
  assert.equal(c(17 * 60 + 30), '5:30 PM');
  assert.equal(c(0), '12:00 AM');
  assert.equal(c(9 * 60 + 5), '9:05 AM');
});

test('_airportBufferMin is 3 hrs international, 2 hrs domestic', () => {
  const buf = fn('_airportBufferMin');
  const intl = fn('_isIntlFlight');
  assert.equal(buf({ international: true }), 180, 'international = 3 hours');
  assert.equal(buf({ international: false }), 120, 'domestic = 2 hours');
  // Explicit choice always wins over the distance guess.
  assert.equal(intl({ international: false, lat: 28.4, lng: -81.3, destLat: 51.1, destLng: -0.19 }), false);
  // Long-haul with no explicit choice is guessed international; short-haul domestic.
  assert.equal(intl({ lat: 28.4, lng: -81.3, destLat: 51.1, destLng: -0.19 }), true, 'MCO->LGW is international');
  assert.equal(intl({ lat: 28.4, lng: -81.3, destLat: 40.6, destLng: -73.8 }), false, 'MCO->JFK is domestic');
  // No destination coords: detect international from the flight text.
  assert.equal(intl({ type: 'flight', notes: 'Overnight transatlantic flight.' }), true, 'transatlantic text = international');
  assert.equal(intl({ type: 'flight', name: 'Flight to Chicago', notes: 'quick hop' }), false, 'no signal = domestic');
});

test('_airportArrivalHtml shows the be-at-airport time before departure', () => {
  const h = fn('_airportArrivalHtml');
  const intl = h({ type: 'flight', time: '8:30 PM', international: true });
  assert.match(intl, /5:30 PM/, 'international 8:30 PM departure -> at airport 5:30 PM');
  assert.match(intl, /international/);
  const dom = h({ type: 'flight', time: '8:30 PM', international: false });
  assert.match(dom, /6:30 PM/, 'domestic 8:30 PM departure -> at airport 6:30 PM');
  assert.equal(h({ type: 'hike', time: '9:00 AM' }), '', 'non-flights get no airport line');
});

test('_flightDepMins tolerates timezone suffixes and reads notes', () => {
  const dep = fn('_flightDepMins');
  const p = fn('_parseTimeMins');
  assert.equal(dep({ time: '8:30 PM' }), p('8:30 PM'));
  assert.equal(dep({ time: '8:30 PM EDT' }), p('8:30 PM'), 'a timezone suffix must not break it');
  assert.equal(dep({ time: '', notes: 'Departs Orlando 8:30 PM.' }), p('8:30 PM'), 'falls back to Departs ... in notes');
});

// ---------------------------------------------------------------------------
// REGRESSION (app-unusable incident): moving ONE stop rewrote the whole day.
// A dinner set for 6:30 PM was dragged to 2:29 PM and the hotel to 4:04 PM,
// because _recalcDayTimes discarded every user-set time and re-packed the day
// back-to-back from the anchor. A time the user set is DATA: it may be pushed
// LATER when physically unreachable, but never pulled earlier or invented.
test('moving a stop preserves every user-set time that is still reachable', () => {
  const move = fn('moveStop');
  ctx.saveState = () => {}; ctx.renderAll = () => {}; ctx.renderDayMap = () => {};
  ctx.currentDayIdx = 0;
  ctx.state = { days: [{ stops: [
    { name: 'Edinburgh Castle', type: 'hike', time: '9:30 AM', endTime: '11:30 AM', lat: 55.9486, lng: -3.1999 },
    { name: 'Lunch', type: 'food', time: '12:00 PM', endTime: '1:00 PM', lat: 55.9489, lng: -3.1953 },
    { name: 'Holyrood Palace', type: 'hike', time: '2:00 PM', endTime: '3:30 PM', lat: 55.9526, lng: -3.1722 },
    { name: 'Dinner', type: 'food', time: '6:30 PM', endTime: '8:00 PM', lat: 55.95, lng: -3.19 },
    { name: 'Hotel', type: 'lodge', time: '9:00 PM', endTime: '9:30 PM', lat: 55.952, lng: -3.188 },
  ] }] };
  move(0, 2, -1);                     // move Holyrood up one slot
  const byName = {};
  for (const s of ctx.state.days[0].stops) byName[s.name] = s.time;
  const p = fn('_parseTimeMins');
  // A move is a SWAP: only the two stops that traded places change.
  assert.equal(p(byName['Holyrood Palace']), p('12:00 PM'), 'the moved stop takes its neighbour’s slot');
  assert.equal(p(byName['Lunch']), p('2:00 PM'), 'the neighbour takes the moved stop’s slot');
  // Everything else in the day is untouched.
  assert.equal(p(byName['Dinner']), p('6:30 PM'), 'dinner must stay at 6:30 PM, not slide to the afternoon');
  assert.equal(p(byName['Hotel']), p('9:00 PM'), 'the hotel must stay at 9:00 PM');
  assert.equal(p(byName['Edinburgh Castle']), p('9:30 AM'), 'the first stop keeps its time');
  // ...and the day is still in chronological order after the swap.
  assert.equal(fn('_firstChronoViolation')(), 0, 'the day must stay chronological');
});

test('an unreachable stop is pushed later, never earlier', () => {
  const recalc = fn('_recalcDayTimes');
  const p = fn('_parseTimeMins');
  ctx.state = { days: [{ stops: [
    { name: 'Stirling', type: 'hike', time: '9:30 AM', endTime: '11:00 AM', lat: 56.1237, lng: -3.948 },
    // ~112 mi away but scheduled 15 min later — impossible; must be pushed out.
    { name: 'Glenfinnan', type: 'hike', time: '11:15 AM', endTime: '12:15 PM', lat: 56.8758, lng: -5.431 },
  ] }] };
  recalc(0);
  assert.equal(p(ctx.state.days[0].stops[0].time), p('9:30 AM'), 'reachable time untouched');
  assert.ok(p(ctx.state.days[0].stops[1].time) > p('11:15 AM'), 'impossible arrival pushed later');
});

// ---------------------------------------------------------------------------
// End Time <-> Duration must always agree (screenshot: 12:03pm–4:12pm showing
// a stale "2hrs" carried over from a previously-edited stop).
test('End Time and Duration stay in sync in both directions', () => {
  const F = { 'f-time': { value: '' }, 'f-endtime': { value: '' }, 'f-duration': { value: '' } };
  const realGet = ctx.document.getElementById;
  ctx.document.getElementById = (id) => F[id] || realGet(id);
  try {
    // Editing Duration moves End Time.
    F['f-time'].value = '12:03pm'; F['f-endtime'].value = '4:12pm'; F['f-duration'].value = '2hrs';
    fn('_fSyncEndFromDur')();
    assert.equal(ctx._parseTimeMins(F['f-endtime'].value), ctx._parseTimeMins('2:03 PM'), 'End = Start + Duration');
    // Editing End Time moves Duration.
    F['f-time'].value = '12:03pm'; F['f-endtime'].value = '4:12pm'; F['f-duration'].value = '2hrs';
    fn('_fSyncDurFromTimes')();
    assert.equal(F['f-duration'].value, '4h 9min', 'Duration = End - Start, not the stale 2hrs');
    // A stop running past midnight must show real elapsed time, not a stale value.
    F['f-time'].value = '9:00 PM'; F['f-endtime'].value = '2:00 AM'; F['f-duration'].value = '2hrs';
    fn('_fSyncDurFromTimes')();
    assert.equal(F['f-duration'].value, '5hrs', 'overnight span is 5 hours, not the stale 2hrs');
  } finally { ctx.document.getElementById = realGet; }
});

// The displayed duration must ALWAYS agree with the times on the same card.
test('_displayDuration is derived from the times, never a stale stored string', () => {
  const d = fn('_displayDuration');
  // The screenshot case: stored "2hrs" contradicts 12:03pm-4:12pm.
  assert.equal(d({ time: '12:03pm', endTime: '4:12pm', duration: '2hrs' }), '4h 9min');
  // Overnight transit.
  assert.equal(d({ time: '9:00 PM', endTime: '2:00 AM', duration: '45min' }), '5hrs');
  // No end time: fall back to whatever was stored.
  assert.equal(d({ time: '9:00 AM', duration: '90min' }), '90min');
  assert.equal(d({ time: '9:00 AM' }), '');
});

test('a rendered card never shows a duration that contradicts its times', () => {
  ctx.state = { title: 'T', days: [{ title: 'D', stops: [
    { name: 'British Museum', type: 'hike', time: '12:03pm', endTime: '4:12pm', duration: '2hrs', lat: 51.5194, lng: -0.127 },
  ] }] };
  ctx.currentDayIdx = 0;
  const html = fn('renderPanel')(0);
  assert.ok(!/2hrs/.test(html), 'the stale stored 2hrs must not be rendered');
  assert.ok(/4h 9min/.test(html), 'the card must show the real 4h 9min span');
});

// ---------------------------------------------------------------------------
// Nothing may be scheduled before you land when travel carries over overnight.
test('_logicErrors flags a stop scheduled BEFORE the overnight arrival', () => {
  const le = fn('_logicErrors');
  const st = { days: [
    { title: 'Day 1', stops: [
      // Overnight flight: leaves 8:30 PM, lands 9:35 AM the next morning.
      { name: 'Flight MCO-LGW', type: 'flight', time: '8:30 PM', endTime: '9:35 AM', lat: 28.43, lng: -81.31 },
    ] },
    { title: 'Day 2', stops: [
      { name: 'British Museum', type: 'hike', time: '8:00 AM', lat: 51.5194, lng: -0.127 },  // before landing!
      { name: 'Tower of London', type: 'hike', time: '2:00 PM', lat: 51.5081, lng: -0.0759 },
    ] },
  ] };
  const errs = le(st);
  const before = errs.filter(e => e.rule === 'Before arrival');
  assert.equal(before.length, 1, 'must flag exactly the pre-arrival stop: ' + JSON.stringify(errs));
  assert.match(before[0].msg, /British Museum/);
  assert.match(before[0].msg, /before you land/);
});

test('_logicErrors accepts a day that starts after the overnight arrival', () => {
  const le = fn('_logicErrors');
  const st = { days: [
    { title: 'Day 1', stops: [{ name: 'Flight', type: 'flight', time: '8:30 PM', endTime: '9:35 AM', lat: 28.43, lng: -81.31 }] },
    { title: 'Day 2', stops: [{ name: 'British Museum', type: 'hike', time: '11:00 AM', lat: 51.5194, lng: -0.127 }] },
  ] };
  assert.equal(le(st).filter(e => e.rule === 'Before arrival').length, 0);
});

// A locked (reserved) time must survive any automatic re-timing.
test('a locked stop keeps its reserved time when a neighbour is moved', () => {
  const move = fn('moveStop');
  const p = fn('_parseTimeMins');
  ctx.saveState = () => {}; ctx.renderAll = () => {}; ctx.renderDayMap = () => {};
  ctx.currentDayIdx = 0;
  ctx.state = { days: [{ stops: [
    { name: 'Castle', type: 'hike', time: '9:30 AM', endTime: '11:00 AM', lat: 55.9486, lng: -3.1999 },
    { name: 'Booked Dinner', type: 'food', time: '12:00 PM', endTime: '1:30 PM', locked: true, lat: 55.9489, lng: -3.1953 },
  ] }] };
  move(0, 0, 1);   // move the castle down, past the locked reservation
  const dinner = ctx.state.days[0].stops.find(s => s.name === 'Booked Dinner');
  assert.equal(p(dinner.time), p('12:00 PM'), 'the reserved time must not move');
});

test('_recalcDayTimes never moves a locked time', () => {
  const recalc = fn('_recalcDayTimes');
  const p = fn('_parseTimeMins');
  ctx.state = { days: [{ stops: [
    { name: 'A', type: 'hike', time: '9:30 AM', endTime: '11:00 AM', lat: 56.1237, lng: -3.948 },
    // Locked yet unreachable — the lock still wins; the gate reports the clash.
    { name: 'Reserved', type: 'food', time: '11:15 AM', endTime: '12:15 PM', locked: true, lat: 56.8758, lng: -5.431 },
  ] }] };
  recalc(0);
  assert.equal(p(ctx.state.days[0].stops[1].time), p('11:15 AM'), 'locked time held');
});

// Start/end each carry their own date and time zone (overnight flights).
test('_endDateOf rolls to the next day when the end time wraps past midnight', () => {
  const f = fn('_endDateOf');
  assert.equal(f({ time: '8:30 PM', endTime: '9:35 AM' }, '2026-08-04'), '2026-08-05', 'lands the next morning');
  assert.equal(f({ time: '9:00 AM', endTime: '11:00 AM' }, '2026-08-04'), '2026-08-04', 'same-day stop');
  assert.equal(f({ time: '8:30 PM', endTime: '9:35 AM', endDate: '2026-08-06' }, '2026-08-04'), '2026-08-06', 'explicit end date wins');
});

test('duration measures a real multi-day span, not a 24h wrap', () => {
  const d = fn('_displayDuration');
  // Aug 4 8:30 PM -> Aug 5 9:35 AM is 13h 5min.
  assert.equal(d({ time: '8:30 PM', endTime: '9:35 AM', startDate: '2026-08-04', endDate: '2026-08-05' }), '13h 5min');
});

test('the time zone falls back to the stop location when not typed', () => {
  const st = fn('_startTz'), et = fn('_endTz');
  assert.equal(st({ tz: 'EDT' }), 'EDT', 'an explicit zone is used as typed');
  assert.equal(et({ tz: 'EDT', endTz: 'BST' }), 'BST', 'the arrival zone is independent');
  assert.equal(et({ tz: 'EDT' }), 'EDT', 'falls back to the start zone');
});
