/**
 * e2e/smoke.mjs
 * Browser smoke test with synthetic exports (no personal data). Drives real
 * Chrome through: upload → hybrid default (light) → each mode → feed → activity
 * detail → dark theme → reload restores from IndexedDB → delete data, with no
 * console errors and no horizontal overflow on a phone.
 *
 *   npm run e2e
 *
 * Skips (exit 0) when Chrome isn't installed. Set CHROME_PATH to override.
 */

import '../tests/parsers/fixtures.js'; // installs the JSZip/DOMParser shims the fixtures use
import { chromium } from 'playwright-core';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip, csv, gpx, STRAVA_HEADERS, stravaRow } from '../tests/parsers/fixtures.js';
import { startServer } from './server.mjs';
import { withExif } from './exif.mjs';

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!CHROME) { console.log('No Chrome found; skipping e2e.'); process.exit(0); }

// ── Synthetic exports ────────────────────────────────────────────────────────
function route(startIso, n = 120) {
  const t0 = Date.parse(startIso);
  return gpx(Array.from({ length: n }, (_, i) => ({
    lat: 40 + i * 0.0004 + Math.sin(i / 9) * 0.0003,
    lon: -75 + i * 0.0003,
    ele: 20 + Math.sin(i / 12) * 8,
    time: new Date(t0 + i * 10000).toISOString().replace('.000', ''),
    hr: 120 + Math.round(Math.sin(i / 15) * 15),
  })));
}

const dir = mkdtempSync(join(tmpdir(), 'fitviz-'));
const rows = [];
const files = {};
for (let i = 0; i < 6; i++) {
  const day = String(10 + i).padStart(2, '0');
  const iso = `2026-04-${day}T07:00:00Z`;
  files[`activities/${1000 + i}.gpx`] = route(iso);
  rows.push(stravaRow({
    id: 1000 + i, date: `Apr ${10 + i}, 2026, 7:00:00 AM`, name: `Morning Run ${i + 1}`, type: 'Run',
    elapsed: 1190, moving: 1180, km: 4.1, meters: 4100, elev: 40, avgHr: 138, maxHr: 165, filename: `activities/${1000 + i}.gpx`,
  }));
}
files['activities.csv'] = csv(STRAVA_HEADERS, rows);
const stravaZip = await makeZip(files, 'strava.zip');

// Apple: the first Strava run again (a duplicate to merge), plus a yoga session and ring summaries.
const w = (type, start, end, extra = '') =>
  `<Workout workoutActivityType="${type}" duration="20" durationUnit="min" sourceName="Watch" startDate="${start}" endDate="${end}">${extra}</Workout>`;
const apple = `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">
${w('HKWorkoutActivityTypeRunning', '2026-04-10 03:01:00 -0400', '2026-04-10 03:21:00 -0400',
  '<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="4.1" unit="km"/><WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="320" unit="Cal"/>')}
${w('HKWorkoutActivityTypeYoga', '2026-04-12 08:00:00 -0400', '2026-04-12 08:30:00 -0400')}
${Array.from({ length: 14 }, (_, i) => ` <ActivitySummary dateComponents="2026-04-${String(1 + i).padStart(2, '0')}" activeEnergyBurned="${300 + i * 30}" activeEnergyBurnedGoal="500" activeEnergyBurnedUnit="Cal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="${20 + i}" appleExerciseTimeGoal="30" appleStandHours="${6 + (i % 7)}" appleStandHoursGoal="12"/>`).join('\n')}
</HealthData>`;
const appleZip = await makeZip({ 'apple_health_export/export.xml': apple }, 'apple.zip');
writeFileSync(join(dir, 'strava.zip'), stravaZip);
writeFileSync(join(dir, 'apple.zip'), appleZip);

// ── Photos: JPEGs rendered by the browser, EXIF spliced in here ─────────────────
const photoSpecs = [
  { name: 'IMG_0001.jpg', datetime: '2026:04:10 07:02:00', offset: '+00:00', lat: 40.0, lon: -75.0 },
  { name: 'IMG_0002.jpg', datetime: '2026:04:10 07:05:00', offset: '+00:00' },          // no GPS: interpolated from the route
  { name: 'IMG_0003.jpg', datetime: '2026:04:10 07:09:00', offset: '+00:00', lat: 40.004, lon: -74.999 },
  { name: 'IMG_0004.jpg', datetime: '2026:04:10 12:00:00', offset: '+00:00' },          // hours after the run: unmatched
];
const photoDir = join(dir, 'photos');
const { mkdirSync } = await import('node:fs');
mkdirSync(photoDir, { recursive: true });

// ── Run ──────────────────────────────────────────────────────────────────────
const { server, port } = await startServer(0);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.log('  FAIL:', msg); } else console.log('  ok:', msg); };

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.route(/arcgisonline|tile\.openstreetmap/, r => r.abort());
const url = `http://127.0.0.1:${port}/`;

// Render a JPEG in the browser, then add EXIF to a copy per photo.
await page.goto('about:blank');
const base64 = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 48;
  const g = c.getContext('2d'); g.fillStyle = '#e65a3c'; g.fillRect(0, 0, 64, 48);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
});
const baseJpeg = Uint8Array.from(Buffer.from(base64, 'base64'));
for (const p of photoSpecs) writeFileSync(join(photoDir, p.name), withExif(baseJpeg, p));


try {
  await page.goto(url);
  await page.waitForSelector('#upload-screen', { state: 'visible' });
  check(await page.evaluate(() => !document.documentElement.classList.contains('dark-mode')), 'defaults to light theme');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#welcome:not([hidden])', { timeout: 3000 });
  check(true, 'closing the first-run dialog leaves a "Load your data" button, not a blank page');
  await page.click('#btn-welcome-upload');
  await page.waitForSelector('#upload-screen', { state: 'visible' });

  await page.setInputFiles('#file-strava', join(dir, 'strava.zip'));
  await page.setInputFiles('#file-apple', join(dir, 'apple.zip'));
  await page.setInputFiles('#file-photos', photoSpecs.map(p => join(photoDir, p.name)));
  await page.click('#btn-go');
  await page.waitForSelector('#app-nav.visible', { timeout: 30000 });
  await page.waitForSelector('#view-today.active .rings', { timeout: 10000 });

  check(await page.evaluate(() => document.body.dataset.mode) === 'hybrid', 'defaults to hybrid mode');
  const tabs = await page.$$eval('#nav-tabs .nav-tab', els => els.map(e => e.dataset.view));
  check(['today', 'feed', 'map', 'awards', 'charts', 'photos'].every(v => tabs.includes(v)), `hybrid nav: ${tabs.join(', ')}`);

  // The Apple run merges into the Strava run: 6 + yoga = 7 visible workouts
  await page.click('#nav-tabs [data-view="feed"]');
  await page.waitForSelector('#view-feed .feed-card');
  const cards = await page.$$eval('#view-feed .feed-card', c => c.length);
  check(cards === 7, `duplicate merged: ${cards} workouts in the feed (expected 7)`);
  check(await page.$$eval('#view-feed .feed-card .src-badge.apple', e => e.length) >= 1, 'merged workout shows both source badges');

  // Activity page
  await page.click('#view-feed .feed-card[href*="strava-1000"]');
  await page.waitForSelector('.act-stats', { timeout: 10000 });
  await page.waitForSelector('.stream-wrap', { timeout: 10000 });
  check(await page.$('table.splits') !== null, 'activity page shows splits');
  check(/#\/activity\//.test(page.url()), 'activity has a shareable URL');

  // Photo Tour: EXIF offset applied (3 of 4 photos fall inside the run), detail + cinema play
  check(await page.$eval('#nav-photos-badge', e => e.textContent) === '3', 'photos matched to the run using their EXIF time offset (badge shows 3)');
  await page.click('#nav-tab-photos');
  await page.waitForSelector('#photos-screen.visible .photos-row', { timeout: 8000 });
  await page.click('#photos-screen-body .photos-row');
  await page.waitForSelector('#photos-screen-body .pd-tile', { timeout: 8000 });
  const tileCount = await page.$$eval('#photos-screen-body .pd-tile', e => e.length);
  check(tileCount === 3, `Photo Tour detail shows the 3 matched photos (got ${tileCount})`);
  await page.click('#photos-screen-body button:has-text("Play")');
  await page.waitForTimeout(1500);
  check(errors.length === 0, 'cinema tour starts without errors');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '#/feed'; });
  await page.waitForSelector('#view-feed.active .feed-card');

  // Rings: month view draws real arcs; cumulative totals are the exact sums
  // (synthetic data: 14 days of April, Move 300+30i against a goal of 500)
  await page.click('#nav-tabs [data-view="today"]');
  await page.waitForSelector('#view-today.active .rings');
  await page.click('[data-range="month"]');
  const cells = await page.$$eval('.rings-month .ring-day.mini', c => ({ all: c.length, drawn: c.filter(x => x.querySelector('.ring-arc')).length }));
  check(cells.drawn === 14, `month view draws arcs on every day with data (${cells.drawn} of 14; ${cells.all} cells in the month)`);
  const moveText = await page.$eval('.ring-stat.move .ring-stat-val', e => e.textContent.replace(/\s+/g, ''));
  check(moveText === '6,930/7,000kcal', `cumulative Move is the sum of every day over the sum of each day's goal (got ${moveText})`);
  await page.click('[data-range="year"]');
  check(await page.$$eval('.rings-year .ring-day', e => e.length) === 12, 'year view shows all 12 months');
  await page.click('[data-range="day"]');

  // Feed: a filter set elsewhere is visible and clearable from the Feed
  await page.evaluate(() => { location.hash = '#/charts'; });
  await page.waitForSelector('#filter-from');
  await page.fill('#filter-from', '2026-04-12');
  await page.dispatchEvent('#filter-from', 'change');
  await page.evaluate(() => { location.hash = '#/feed'; });
  await page.waitForSelector('#view-feed.active .active-filters .chip');
  const narrowed = await page.$$eval('#view-feed .feed-card', c => c.length);
  await page.click('#feed-clear-all');
  await page.waitForFunction(() => document.querySelectorAll('#view-feed .active-filters .chip').length === 0);
  const restored = await page.$$eval('#view-feed .feed-card', c => c.length);
  check(narrowed < restored && restored === 7, `Feed shows a date filter set on Stats and "Clear all" removes it (${narrowed} -> ${restored})`);

  // Modes
  for (const mode of ['apple', 'strava', 'hybrid']) {
    await page.click(`#mode-switch [data-mode="${mode}"]`);
    check(await page.evaluate(() => document.body.dataset.mode) === mode, `switched to ${mode}`);
  }
  await page.click('#mode-switch [data-mode="strava"]');
  await page.evaluate(() => { location.hash = '#/feed'; });
  await page.waitForSelector('#view-feed.active .feed-card');
  check(await page.$$eval('#nav-tabs .nav-tab', e => e.map(x => x.dataset.view).includes('profile')), 'strava mode has Profile');

  // Theme
  await page.click('#btn-theme-toggle');
  check(await page.evaluate(() => document.documentElement.classList.contains('dark-mode')), 'dark theme can be selected');
  await page.click('#btn-theme-toggle');

  // Persistence: wait for the background route save, then reload
  await page.click('#mode-switch [data-mode="hybrid"]');
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForSelector('#app-nav.visible', { timeout: 15000 });
  check(await page.evaluate(() => !document.getElementById('upload-modal-backdrop').classList.contains('visible')), 'reload restores data without the upload dialog');

  // Phone: no horizontal overflow
  await page.setViewportSize({ width: 390, height: 800 });
  for (const v of ['today', 'feed', 'map', 'awards', 'charts']) {
    await page.evaluate((h) => { location.hash = `#/${h}`; }, v);
    await page.waitForTimeout(700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(over <= 0, `no horizontal overflow on ${v} at 390px`);
  }

  // Delete
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.click('#btn-menu');
  await page.click('#btn-delete-data');
  await page.click('#btn-delete-data');
  await page.waitForSelector('#upload-modal-backdrop.visible');
  await page.reload();
  await page.waitForSelector('#upload-modal-backdrop.visible');
  check(true, 'delete wipes saved data (upload dialog returns after reload)');

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  failures.push(`exception: ${e.message}`);
  console.log('  EXCEPTION:', e.message);
}

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
