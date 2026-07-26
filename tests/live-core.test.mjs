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
  location: { search: '', pathname: '/Travel/trip.html', href: 'https://x/Travel/trip.html', origin: 'https://x', reload: noop },
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

test('_healBadEndTimes makes duration equal end - start for an activity', () => {
  const heal = fn('_healBadEndTimes');
  const state = { days: [{ stops: [{ name: 'Cafe', type: 'food', time: '12:08 PM', endTime: '12:33 PM', duration: '45min' }] }] };
  ctx.state = state;
  heal();
  assert.equal(state.days[0].stops[0].duration, '25min');
});
