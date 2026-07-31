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
  // Glenfinnan at 12:15 — 77 mi needs ~51 min even with a zero-length lunch, so
  // that time is unreachable. The app must now FIX it (push the stop to the
  // earliest time it can actually be reached) rather than refuse the save and
  // leave the user to work it out.
  ctx.state.days[0].stops[1].time = '12:15 PM';
  save();
  assert.ok(persisted, 'the corrected itinerary IS written');
  assert.equal(alerted, '', 'no error is shown for something the app can fix');
  const p = fn('_parseTimeMins');
  const fixed = ctx.state.days[0].stops[1];
  assert.ok(p(fixed.time) > p('12:15 PM'), 'the unreachable stop was pushed later, got ' + fixed.time);
  assert.equal(fn('_logicErrors')(ctx.state).length, 0,
    'after the auto-fix the itinerary is physically possible: ' + JSON.stringify(fn('_logicErrors')(ctx.state)));
});

test('saveState still REFUSES when even the auto-fix cannot make it work', () => {
  const save = fn('saveState'), seed = fn('_seedLogicBaseline');
  // 77 mi apart. The table is LOCKED so it cannot be pushed later, and it starts
  // only 5 min after lunch — even a zero-length lunch cannot cover the travel.
  // Nothing the app can do makes this possible, so it must refuse.
  ctx.state = { tripType: 'solo', days: [{ stops: [
    { name: 'Lunch', type: 'food', time: '8:00 PM', endTime: '9:00 PM', lat: 56.12, lng: -3.94 },
    { name: 'Booked table', type: 'food', time: '8:30 PM', endTime: '10:00 PM', locked: true, lat: 56.8758, lng: -5.431 },
  ] }] };
  seed();
  let persisted = null, alerted = '';
  ctx.localStorage.setItem = (k, v) => { persisted = v; };
  ctx.alert = (m) => { alerted = m; };
  ctx.state.days[0].stops[1].time = '8:05 PM';   // 5 minutes for a 77-mile trip
  save();
  assert.equal(persisted, null, 'a locked, unreachable stop cannot be auto-fixed → refuse');
  assert.match(alerted, /physical world|Impossible/, 'and say so');
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
test('moving a stop starts it at the previous stop\'s end + travel time', () => {
  const move = fn('moveStop');
  const p = fn('_parseTimeMins');
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
  const stops = ctx.state.days[0].stops;
  const at = (n) => stops.find(s => s.name === n);
  // Order changed as requested.
  assert.equal(stops[1].name, 'Holyrood Palace');
  assert.equal(stops[2].name, 'Lunch');
  // Each moved stop begins when it can actually be REACHED: prev end + travel.
  assert.ok(p(at('Holyrood Palace').time) >= p(at('Edinburgh Castle').endTime),
    'Holyrood starts at/after the castle ends');
  assert.ok(p(at('Lunch').time) >= p(at('Holyrood Palace').endTime),
    'Lunch starts at/after Holyrood ends');
  // Nothing beyond the two swapped positions is touched.
  assert.equal(p(at('Edinburgh Castle').time), p('9:30 AM'), 'the first stop keeps its time');
  assert.equal(p(at('Dinner').time), p('6:30 PM'), 'dinner must not move');
  assert.equal(p(at('Hotel').time), p('9:00 PM'), 'the hotel must not move');
  assert.equal(fn('_firstChronoViolation')(), 0, 'the day stays chronological');
});

test('_retimeFromPrev never moves a locked reservation', () => {
  const rt = fn('_retimeFromPrev'), p = fn('_parseTimeMins');
  const stops = [
    { name: 'A', type: 'hike', time: '9:00 AM', endTime: '10:00 AM', lat: 55.94, lng: -3.19 },
    { name: 'Booked', type: 'food', time: '12:00 PM', endTime: '1:00 PM', locked: true, lat: 55.95, lng: -3.18 },
  ];
  assert.equal(rt(stops, 1), false, 'a locked stop is not re-timed');
  assert.equal(p(stops[1].time), p('12:00 PM'), 'its reserved time holds');
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

// One stop that spans midnight is ONE event: shown as a continuation on the day
// it ends, never duplicated as a second stop the user has to manage.
test('an overnight stop appears as a continuation, not a duplicate stop', () => {
  ctx.state = { title: 'T', days: [
    { title: 'Day 1', subtitle: 'Tue, Aug 4, 2026', stops: [
      { name: 'Flight MCO-LGW', type: 'flight', time: '8:30 PM', endTime: '9:35 AM', endTz: 'BST', lat: 28.43, lng: -81.31 },
    ] },
    { title: 'Day 2', subtitle: 'Wed, Aug 5, 2026', stops: [
      { name: 'British Museum', type: 'hike', time: '11:00 AM', lat: 51.5194, lng: -0.127 },
    ] },
  ] };
  ctx.currentDayIdx = 1;
  const html = fn('renderPanel')(1);
  assert.match(html, /Continues from Day 1/, 'day 2 must show the flight as a continuation');
  assert.match(html, /9:35 AM/, 'it must state the arrival time');
  // Day 2 still owns exactly ONE real stop — the flight was not duplicated into it.
  assert.equal(ctx.state.days[1].stops.length, 1, 'no duplicate arrival stop was added');
});

// ---------------------------------------------------------------------------
// ROOT FLAW: times were stored as minutes-since-midnight with NO date, so
// "Aug 4 8:00 PM -> Aug 5 10:00 AM" was rejected as "end before start".
test('an overnight stop across two dates is ordered correctly', () => {
  const sAbs = fn('_stopStartAbs'), eAbs = fn('_stopEndAbs');
  const stop = { time: '8:00 PM', endTime: '10:00 AM', startDate: '2026-08-04', endDate: '2026-08-05' };
  assert.ok(eAbs(stop) > sAbs(stop), 'Aug 5 10:00 AM must come AFTER Aug 4 8:00 PM');
  // Bare clock minutes are what made this look backwards:
  const p = fn('_parseTimeMins');
  assert.ok(p('10:00 AM') < p('8:00 PM'), 'clock-only comparison is why it broke');
});

test('the end date is inferred when a stop wraps past midnight', () => {
  const eAbs = fn('_stopEndAbs'), sAbs = fn('_stopStartAbs');
  const stop = { time: '8:00 PM', endTime: '10:00 AM', startDate: '2026-08-04' }; // no endDate
  assert.ok(eAbs(stop) > sAbs(stop), 'inferred next day, so the end is still after the start');
  assert.equal(eAbs(stop) - sAbs(stop), 14 * 60, 'exactly 14 hours');
});

test('a same-day stop is unaffected', () => {
  const eAbs = fn('_stopEndAbs'), sAbs = fn('_stopStartAbs');
  const stop = { time: '9:00 AM', endTime: '11:30 AM', startDate: '2026-08-04' };
  assert.equal(eAbs(stop) - sAbs(stop), 150, '2h 30min, no date rollover');
});

// ---------------------------------------------------------------------------
// A bare "8:30" was silently read as 8:30 AM. That single ambiguity produced an
// 8:30 PM flight showing a 25h 30min duration and a 5:30 AM airport time.
test('an ambiguous bare time is canonicalised, never silently assumed AM', () => {
  const canon = fn('_canonicalizeTimes');
  ctx.state = { days: [{ stops: [
    { name: 'Flight', type: 'flight', time: '8:30', endTime: '10AM' },
  ] }] };
  canon();
  const s = ctx.state.days[0].stops[0];
  assert.match(s.time, /AM|PM/, 'the stored time must state AM/PM: ' + s.time);
  assert.match(s.endTime, /AM|PM/, 'the stored end time must state AM/PM: ' + s.endTime);
});

test('time input conversion round-trips without losing AM/PM', () => {
  const toIn = fn('_toTimeInput'), fromIn = fn('_fromTimeInput');
  assert.equal(toIn('8:30 PM'), '20:30', 'PM maps to 24h');
  assert.equal(fromIn('20:30'), '8:30 PM', 'and back again');
  assert.equal(fromIn(toIn('12:05 AM')), '12:05 AM', 'midnight hour survives');
  assert.equal(fromIn(toIn('12:05 PM')), '12:05 PM', 'noon hour survives');
});

test('the real flight reads 13h 30min, not 25h 30min', () => {
  const d = fn('_displayDuration');
  const flight = { time: '8:30 PM', endTime: '10:00 AM', startDate: '2026-08-04', endDate: '2026-08-05' };
  assert.equal(d(flight), '13h 30min');
});

// ---------------------------------------------------------------------------
// REVIEW FIX P0-1: saveStop rebuilt the stop from scratch and silently dropped
// every field the form does not show.
test('editing a stop preserves fields the form never exposes', () => {
  const F = {};
  const mk = (id, v) => (F[id] = { value: v == null ? '' : String(v), checked: false, type: '', dataset: {} });
  ['f-name','f-lat','f-lng','f-time','f-endtime','f-duration','f-stars','f-notes','f-reservation',
   'f-from','f-to','f-airline','f-flightnum','f-url','f-audiourl','f-date','f-enddate','f-tz','f-endtz',
   'f-type','f-alt','f-locked','f-intl','f-photo','f-ticket'].forEach(id => mk(id));
  F['f-name'].value = 'British Museum';
  F['f-time'].value = '12:03 PM'; F['f-endtime'].value = '4:12 PM';
  F['f-type'].value = 'hike'; F['f-date'].value = '2026-08-05';
  const realGet = ctx.document.getElementById;
  const realQS = ctx.document.querySelector;
  ctx.document.getElementById = (id) => (id in F ? F[id] : realGet(id));
  ctx.document.querySelector = () => ({ textContent: '', classList: { add(){}, remove(){} } });
  const existing = {
    name: 'British Museum', type: 'hike', time: '12:03 PM', endTime: '4:12 PM',
    _sid: 'sid-keep-me', guidebook: 'GUIDEBOOK TEXT', dayHours: '10:00 AM - 5:00 PM',
    dayHoursSrc: 'osm', destLat: 51.5, destLng: -0.12, recentlyChanged: true,
    lat: 51.5194, lng: -0.127,
  };
  ctx.state = { tripType: 'solo', days: [{ title: 'D', subtitle: 'Wed, Aug 5, 2026', stops: [existing] }] };
  ctx.editingStop = { dayIdx: 0, stopIdx: 0 };
  ctx.addingToDay = 0;
  ctx.saveState = () => {}; ctx.renderAll = () => {}; ctx.closeModal = () => {}; ctx.renderDayMap = () => {};
  try {
    fn('saveStop')();
    const s = ctx.state.days[0].stops[0];
    assert.equal(s._sid, 'sid-keep-me', '_sid must survive (journal notes are keyed by it)');
    assert.equal(s.guidebook, 'GUIDEBOOK TEXT', 'guidebook must survive');
    assert.equal(s.dayHours, '10:00 AM - 5:00 PM', 'dayHours must survive');
    assert.equal(s.dayHoursSrc, 'osm', 'dayHoursSrc must survive');
    assert.equal(s.destLat, 51.5, 'destLat must survive');
    assert.equal(s.destLng, -0.12, 'destLng must survive');
  } finally {
    ctx.document.getElementById = realGet; ctx.document.querySelector = realQS;
    ctx.editingStop = null;
  }
});

// REVIEW FIX P0-2: local dates must not be serialized through UTC.
test('_localISO returns the LOCAL calendar date (no UTC day shift)', () => {
  const iso = fn('_localISO');
  const d = new Date(2026, 7, 5, 0, 0, 0); // Aug 5 2026, local midnight
  assert.equal(iso(d), '2026-08-05', 'must stay Aug 5 regardless of UTC offset');
  assert.equal(iso(new Date(2026, 0, 1, 23, 59)), '2026-01-01');
});

// REVIEW FIX P0-3: no airport warning against the PREVIOUS DAY's last stop.
test('_airportWarningHtml is silent when there is no same-day previous stop', () => {
  assert.equal(fn('_airportWarningHtml')(null, { type: 'flight', time: '10:00 AM' }), '',
    'a day-first flight must not be judged against yesterday');
});

// ===========================================================================
// DURATION — the root-cause fix. Duration must be measured between absolute
// INSTANTS, not by subtracting wall clocks. Orlando 8:30 PM EDT -> London
// 10:00 AM BST is 8h 30min; clock arithmetic says 13h 30min because it ignores
// the 5-hour offset change, and with a lost PM the app showed 25h 30min.
// ===========================================================================
const DURATION_CASES = [
  ['MCO->LGW transatlantic eastbound', { time: '8:30 PM', endTime: '10:00 AM', startDate: '2026-08-04', endDate: '2026-08-05', tz: 'America/New_York', endTz: 'Europe/London' }, '8h 30min'],
  ['LGW->MCO transatlantic westbound', { time: '11:00 AM', endTime: '3:30 PM', startDate: '2026-08-14', endDate: '2026-08-14', tz: 'Europe/London', endTz: 'America/New_York' }, '9h 30min'],
  ['JFK->LAX westbound, same day', { time: '10:00 AM', endTime: '1:00 PM', startDate: '2026-08-04', endDate: '2026-08-04', tz: 'America/New_York', endTz: 'America/Los_Angeles' }, '6hrs'],
  ['LAX->JFK redeye, lands next day', { time: '10:00 PM', endTime: '6:30 AM', startDate: '2026-08-04', endDate: '2026-08-05', tz: 'America/Los_Angeles', endTz: 'America/New_York' }, '5h 30min'],
  ['SYD->LAX crosses the date line backwards', { time: '10:00 AM', endTime: '6:00 AM', startDate: '2026-08-04', endDate: '2026-08-04', tz: 'Australia/Sydney', endTz: 'America/Los_Angeles' }, '13hrs'],
  ['zone abbreviations typed by the user', { time: '8:30 PM', endTime: '10:00 AM', startDate: '2026-08-04', endDate: '2026-08-05', tz: 'EDT', endTz: 'BST' }, '8h 30min'],
  ['same zone, crosses midnight', { time: '9:00 PM', endTime: '2:00 AM', startDate: '2026-08-04', endDate: '2026-08-05', tz: 'Europe/London', endTz: 'Europe/London' }, '5hrs'],
  ['ordinary same-day visit', { time: '12:03 PM', endTime: '4:12 PM', startDate: '2026-08-05', endDate: '2026-08-05', tz: 'Europe/London', endTz: 'Europe/London' }, '4h 9min'],
  ['no zone info falls back to clock math', { time: '9:00 AM', endTime: '11:30 AM', startDate: '2026-08-05' }, '2h 30min'],
];
for (const [label, stop, expected] of DURATION_CASES) {
  test('duration: ' + label, () => {
    assert.equal(fn('_displayDuration')(stop, stop.startDate), expected);
  });
}

test('duration: the exact bug from the screenshot is gone', () => {
  const d = fn('_displayDuration');
  const flight = { type: 'flight', time: '8:30 PM', endTime: '10:00 AM',
    startDate: '2026-08-04', endDate: '2026-08-05', tz: 'America/New_York', endTz: 'Europe/London' };
  const got = d(flight, '2026-08-04');
  assert.notEqual(got, '25h 30min', 'the lost-PM value must never appear');
  assert.notEqual(got, '13h 30min', 'the timezone-blind value must never appear');
  assert.equal(got, '8h 30min', 'the real Norse Atlantic ZO 784 flight time');
});

test('_zoneOffsetMins handles IANA zones (DST aware) and abbreviations', () => {
  const z = fn('_zoneOffsetMins');
  assert.equal(z('America/New_York', '2026-08-04', '8:30 PM'), -240, 'EDT in August');
  assert.equal(z('America/New_York', '2026-01-04', '8:30 PM'), -300, 'EST in January');
  assert.equal(z('Europe/London', '2026-08-05', '10:00 AM'), 60, 'BST in August');
  assert.equal(z('Europe/London', '2026-01-05', '10:00 AM'), 0, 'GMT in January');
  assert.equal(z('EDT'), -240); assert.equal(z('BST'), 60); assert.equal(z('UTC'), 0);
  assert.equal(z(''), null, 'unknown zone must not silently become 0');
  assert.equal(z('NOPE'), null);
});

test('a lost AM/PM is repaired, killing the 25h 30min reading', () => {
  const canon = fn('_canonicalizeTimes');
  ctx.state = { days: [{ stops: [{ name: 'Flight', type: 'flight', time: '8:30', endTime: '10AM' }] }] };
  canon();
  const s = ctx.state.days[0].stops[0];
  assert.match(s.time, /\d:\d\d (AM|PM)$/, 'canonical, explicit meridiem: ' + s.time);
  assert.match(s.endTime, /\d:\d\d (AM|PM)$/, 'canonical end: ' + s.endTime);
});

// ===========================================================================
// AUTO-FIX: a stop scheduled before you land must be MOVED automatically, not
// rejected with an error the user has to repair by hand. (Screenshot: setting
// the flight arrival to 10:00 AM refused the save because Day 2's hotel sat at
// 9:00 AM.)
// ===========================================================================
function overnightTrip() {
  return { days: [
    { title: 'Day 1', stops: [
      { name: 'Flight ZO 784', type: 'flight', time: '8:30 PM', endTime: '10:00 AM', lat: 28.43, lng: -81.31 },
    ] },
    { title: 'Day 2', stops: [
      { name: 'Royal Horseguards Hotel', type: 'lodge', time: '9:00 AM', endTime: '9:30 AM', lat: 51.5063, lng: -0.1237 },
      { name: 'British Museum', type: 'hike', time: '11:00 AM', endTime: '1:00 PM', lat: 51.5194, lng: -0.127 },
    ] },
  ] };
}

test('a stop before the landing time is moved automatically', () => {
  const shift = fn('_shiftStopsAfterArrival');
  const p = fn('_parseTimeMins');
  const st = overnightTrip();
  const moved = shift(st);
  assert.equal(moved.length, 1, 'exactly the offending stop moves: ' + JSON.stringify(moved));
  assert.equal(moved[0].stop, 'Royal Horseguards Hotel');
  const hotel = st.days[1].stops[0];
  assert.ok(p(hotel.time) >= p('10:00 AM'), 'hotel must start at/after the 10:00 AM landing, got ' + hotel.time);
  assert.equal(p(st.days[1].stops[1].time), p('11:00 AM'), 'a stop already after landing is left alone');
});

test('after the auto-shift there is no Before arrival error left', () => {
  const shift = fn('_shiftStopsAfterArrival'), le = fn('_logicErrors');
  const st = overnightTrip();
  assert.ok(le(st).some(e => e.rule === 'Before arrival'), 'precondition: the error exists');
  shift(st);
  assert.equal(le(st).filter(e => e.rule === 'Before arrival').length, 0,
    'the save must no longer be refused');
});

test('the auto-shift preserves each stop\'s own visit length', () => {
  const shift = fn('_shiftStopsAfterArrival'), p = fn('_parseTimeMins');
  const st = overnightTrip();
  shift(st);
  const hotel = st.days[1].stops[0];
  assert.equal(p(hotel.endTime) - p(hotel.time), 30, 'the 30-minute check-in stays 30 minutes');
});

test('a LOCKED reservation is never moved by the auto-shift', () => {
  const shift = fn('_shiftStopsAfterArrival'), p = fn('_parseTimeMins');
  const st = overnightTrip();
  st.days[1].stops[0].locked = true;
  const moved = shift(st);
  assert.equal(moved.length, 0, 'a locked stop must not be moved');
  assert.equal(p(st.days[1].stops[0].time), p('9:00 AM'), 'its reserved time holds');
});

test('the auto-shift does nothing when no travel carries over', () => {
  const shift = fn('_shiftStopsAfterArrival');
  const st = { days: [{ title: 'D', stops: [
    { name: 'Castle', type: 'hike', time: '9:30 AM', endTime: '11:00 AM', lat: 55.9486, lng: -3.1999 },
  ] }] };
  assert.equal(shift(st).length, 0);
});

// A Duration with no End Time is complete information — compute the end rather
// than refusing the save.
test('saving with a Duration but no End Time computes the end time', () => {
  const F = {};
  const mk = (id, v) => (F[id] = { value: v == null ? '' : String(v), checked: false, type: '', dataset: {} });
  ['f-name','f-lat','f-lng','f-time','f-endtime','f-duration','f-stars','f-notes','f-reservation',
   'f-from','f-to','f-airline','f-flightnum','f-url','f-audiourl','f-date','f-enddate','f-tz','f-endtz',
   'f-type','f-alt','f-locked','f-intl','f-photo','f-ticket'].forEach(id => mk(id));
  F['f-name'].value = 'British Museum';
  F['f-time'].value = '12:00 PM';
  F['f-endtime'].value = '';        // deliberately blank
  F['f-duration'].value = '2h';     // ...but a duration is given
  F['f-type'].value = 'hike';
  const realGet = ctx.document.getElementById, realQS = ctx.document.querySelector;
  ctx.document.getElementById = (id) => (id in F ? F[id] : realGet(id));
  ctx.document.querySelector = () => ({ textContent: '', classList: { add(){}, remove(){} } });
  let alerted = '';
  const realAlert = ctx.alert; ctx.alert = (m) => { alerted = m; };
  ctx.state = { tripType: 'solo', days: [{ title: 'D', subtitle: 'Wed, Aug 5, 2026', stops: [] }] };
  ctx.editingStop = null; ctx.addingToDay = 0;
  ctx.saveState = () => {}; ctx.renderAll = () => {}; ctx.closeModal = () => {}; ctx.renderDayMap = () => {};
  try {
    fn('saveStop')();
    assert.equal(alerted, '', 'no error: a duration is enough to work out the end');
    const s = ctx.state.days[0].stops[0];
    assert.ok(s, 'the stop was saved');
    assert.equal(fn('_parseTimeMins')(s.endTime), fn('_parseTimeMins')('2:00 PM'), 'end = start + 2h, got ' + s.endTime);
  } finally {
    ctx.document.getElementById = realGet; ctx.document.querySelector = realQS; ctx.alert = realAlert;
  }
});

// ===========================================================================
// MAP: the drive to the airport must be drawn. A flight stop's coordinates ARE
// the departure airport, so filtering flights out of the route deleted that
// endpoint — Day 1 (New Port Richey -> Orlando airport -> fly) drew no line.
// ===========================================================================
test('_groundSegments keeps the drive TO the airport', () => {
  const seg = fn('_groundSegments');
  const stops = [
    { name: 'New Port Richey', type: 'hike', lat: 28.2442, lng: -82.7192 },
    { name: 'Flight ZO 784', type: 'flight', lat: 28.4312, lng: -81.3081 },   // = MCO
  ];
  const segs = seg(stops);
  assert.equal(segs.length, 1, 'one ground segment: the drive to the airport');
  assert.equal(segs[0].length, 2, 'both endpoints kept');
  assert.equal(segs[0][0].name, 'New Port Richey');
  assert.equal(segs[0][1].name, 'Flight ZO 784', 'the airport end must survive');
});

test('_groundSegments never draws a road line for the flight itself', () => {
  const seg = fn('_groundSegments');
  // Drive to the airport, fly, then drive from the arrival airport to a hotel.
  const stops = [
    { name: 'Home', type: 'hike', lat: 28.2442, lng: -82.7192 },
    { name: 'Flight', type: 'flight', lat: 28.4312, lng: -81.3081 },
    { name: 'Hotel', type: 'lodge', lat: 51.5063, lng: -0.1237 },
  ];
  const segs = seg(stops);
  assert.equal(segs.length, 1, 'the flight ends the segment; the lone hotel starts no new one');
  const names = segs.flat().map(s => s.name);
  assert.ok(!(names.includes('Flight') && names.includes('Hotel')),
    'the flight and the arrival-side stop must never share a road segment');
});

test('_groundSegments splits a day that drives, flies, then drives again', () => {
  const seg = fn('_groundSegments');
  const stops = [
    { name: 'Home', type: 'hike', lat: 28.24, lng: -82.72 },
    { name: 'Flight', type: 'flight', lat: 28.43, lng: -81.31 },
    // The train knows where it arrives (Victoria), so the onward drive is drawable.
    { name: 'Gatwick Express', type: 'train', lat: 51.1537, lng: -0.1821,
      to: 'London Victoria', destLat: 51.4952, destLng: -0.1441 },
    { name: 'Hotel', type: 'lodge', lat: 51.5063, lng: -0.1237 },
  ];
  const segs = seg(stops);
  assert.equal(segs.length, 2, 'two ground segments, split by the flight');
  assert.deepEqual(JSON.stringify(segs[0].map(s => s.name)), JSON.stringify(['Home', 'Flight']));
  // The second resumes at the train's ARRIVAL, then drives on to the hotel.
  assert.equal(segs[1].length, 2);
  assert.equal(segs[1][0].lat, 51.4952, 'resumes at London Victoria, not Gatwick');
  assert.equal(segs[1][1].name, 'Hotel');
});

test('_groundSegments ignores alternates and stops without coordinates', () => {
  const seg = fn('_groundSegments');
  const segs = seg([
    { name: 'A', type: 'hike', lat: 28.24, lng: -82.72 },
    { name: 'Alt', type: 'hike', lat: 28.3, lng: -82.6, alt: true },
    { name: 'NoCoords', type: 'hike' },
    { name: 'B', type: 'hike', lat: 28.43, lng: -81.31 },
  ]);
  assert.equal(JSON.stringify(segs.map(x => x.map(s => s.name))), JSON.stringify([['A', 'B']]));
});

// ===========================================================================
// MEAL LENGTHS. A flat 75-minute block for every food stop produced 2-hour
// lunches — dead time, not dining.
// ===========================================================================
test('meals get realistic default lengths', () => {
  const v = fn('_stopVisitMins');
  assert.equal(v({ name: 'Breakfast at the hotel', type: 'food' }), 30, 'breakfast 30 min');
  assert.equal(v({ name: 'Lunch — Cheapside', type: 'food' }), 45, 'lunch 45 min');
  assert.equal(v({ name: 'Dinner — Flat Iron Covent Garden', type: 'food' }), 75, 'dinner 1h 15min');
  assert.equal(v({ name: 'Brunch', type: 'food' }), 45, 'brunch 45 min');
  assert.equal(v({ name: 'Gelupo Gelato', type: 'food' }), 30, 'a gelato stop is quick');
  assert.equal(v({ name: 'Coffee at Monmouth', type: 'food' }), 30, 'coffee is quick');
});

test('an explicit time span always beats the meal default', () => {
  const v = fn('_stopVisitMins');
  // A long dinner the user actually chose must be respected.
  assert.equal(v({ name: 'Dinner', type: 'food', time: '7:00 PM', endTime: '9:30 PM' }), 150);
  assert.equal(v({ name: 'Lunch', type: 'food', duration: '2hrs' }), 120, 'a stated duration wins');
});

test('non-meal food and other types are unaffected', () => {
  const v = fn('_stopVisitMins');
  assert.equal(v({ name: 'Borough Market', type: 'food' }), 45, 'generic food falls back to 45');
  assert.equal(v({ name: 'Edinburgh Castle', type: 'hike' }), 120, 'sights unchanged');
});

// ===========================================================================
// MAP: a day must NEVER end up with no route line. Segmentation can strand
// stops — a train/flight with no arrival coordinates ends a segment and leaves
// the rest as a single undrawable point.
// ===========================================================================
test('a day whose segments all collapse still gets a route', () => {
  const pick = fn('_routeSegmentsForDay');
  // Transit first (no arrival coords) then ONE stop: normal segmentation yields
  // nothing drawable, so the safety net must connect the located stops.
  const stops = [
    { name: 'Land at Gatwick', type: 'flight', lat: 51.1537, lng: -0.1821 },
    { name: 'Hotel', type: 'lodge', lat: 51.5063, lng: -0.1237 },
  ];
  assert.equal(fn('_groundSegments')(stops).length, 0, 'precondition: segmentation strands them');
  const segs = pick(stops);
  assert.ok(segs.length >= 1, 'a route is produced anyway');
  assert.ok(segs[0].length >= 2, 'with at least two points to draw between');
});

test('the safety net does not override normal segmentation', () => {
  const pick = fn('_routeSegmentsForDay');
  const stops = [
    { name: 'Home', type: 'hike', lat: 28.24, lng: -82.72 },
    { name: 'Flight', type: 'flight', lat: 28.43, lng: -81.31 },
    { name: 'A', type: 'hike', lat: 51.50, lng: -0.12 },
    { name: 'B', type: 'hike', lat: 51.52, lng: -0.13 },
  ];
  const segs = pick(stops);
  assert.equal(segs.length, 2, 'proper segments are kept, not flattened');
  assert.ok(!segs.some(sg => sg.some(x => x.name === 'Flight') && sg.some(x => x.name === 'A')),
    'the flight leg is still never drawn as a road');
});

test('a day with no usable coordinates draws nothing (and does not throw)', () => {
  const pick = fn('_routeSegmentsForDay');
  assert.equal(pick([{ name: 'X', type: 'hike' }]).length, 0);
  assert.equal(pick([]).length, 0);
});
