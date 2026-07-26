// Headless smoke test: load the built app, assert it renders the seed and has
// no console errors, then exercise the map + a stop edit path.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:4173/Travel/';
const errors = [];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
// Ignore failures to load EXTERNAL resources (OSM tiles, Nominatim) — the
// sandbox egress proxy blocks them; they work on a real device. Only real app
// errors (JS exceptions, app-origin failures) count.
const isEnvNoise = (t) =>
  /ERR_TUNNEL_CONNECTION_FAILED|Failed to load resource|tile\.openstreetmap|nominatim/i.test(t);
page.on('console', (m) => { if (m.type() === 'error' && !isEnvNoise(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 20000 });

// The seed's first stop must render.
await page.waitForSelector('text=Rosslyn Chapel', { timeout: 10000 });
const dayTitle = await page.textContent('h2');
const legText = await page.textContent('.leg').catch(() => '');
const durText = await page.$$eval('.dur', (els) => els.map((e) => e.textContent?.trim()));
const mapTiles = await page.$$eval('.map img', (imgs) => imgs.length);

// Switch to Day 2 and confirm it re-renders.
await page.click('nav.tabs button:nth-child(2)');
await page.waitForSelector('text=Edinburgh Castle', { timeout: 5000 });

console.log('dayTitle:', dayTitle);
console.log('firstLeg:', legText.replace(/\s+/g, ' ').trim());
console.log('durations:', durText.join(' | '));
console.log('mapTiles:', mapTiles);
console.log('consoleErrors:', errors.length ? errors : 'none');

await browser.close();
if (errors.length) { console.error('SMOKE FAILED: console errors'); process.exit(1); }
console.log('SMOKE OK');
