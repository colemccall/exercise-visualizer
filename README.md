# Fitness Visualizer

A **100% client-side** fitness app. Drop in your Strava and/or Apple Health export and get an activity feed, per-activity analysis (splits, pace / heart-rate / elevation charts, best efforts), Apple-style Activity Rings, trends and awards, a heatmap of every route, and a photo tour that pairs your camera roll with the workout it was taken during.

Your files never leave the browser. There is no server, no account, no cloud storage. Your data is saved *in your browser* (IndexedDB) so it's still there next visit, and **Menu → Delete my data** wipes it.

**Live app:** https://colemccall.github.io/exercise-visualizer/

---

## Three experiences, one data set

The app opens in **Hybrid**; the switcher in the top bar changes the whole look and feel. A mode that needs a source you haven't loaded is disabled.

| | **Hybrid** (default) | **Apple** | **Strava** |
|---|---|---|---|
| Data | everything, duplicates merged | Apple Health workouts + rings | Strava activities |
| Landing | **Today**: rings, trends, latest activity | **Summary**: rings, trends, recent workouts | **Feed**: activity cards with route thumbnails |
| Nav | Today · Feed · Map · Awards · Stats · Photos | Summary · Workouts · Awards · Map · Photos | Feed · Map · Profile · Photos |
| Feel | rounded type, orange accent, rings | near-black canvas, rounded numerals, spring motion | dense cards, condensed type, data-first |

Every mode comes in **light** (default) and **dark**, each independently designed and WCAG AA checked (`npm run contrast`), not a token flip over one palette. Activity-type colours use the colour-blind-safe Okabe-Ito palette in every variant. The layout is built for both phone (bottom tab bar, 44px targets) and desktop.

### What's in it

- **Activity rings** (Move / Exercise / Stand) for a day, week or month, with streaks, from Apple's own ActivitySummary. No Apple data → no rings (nothing is estimated).
- **Trends**: last 90 days against the past year, Apple-style.
- **Awards**: distance, streaks, consistency, personal records, monthly challenge and ring badges, with progress toward the next ones.
- **Feed** with route thumbnails, month totals and a "this week" panel.
- **Activity page** (`#/activity/<id>`, linkable): route map coloured by pace or heart rate, headline numbers, **splits**, **best efforts** (400 m → marathon for runs, 5–40 km for rides, with PR badges), and synced elevation / pace / heart-rate / cadence / power charts: scrub any chart and a marker follows along the route.
- **Profile / Stats**: yearly totals with a year selector, distance by month against the previous year, weekly consistency, per-type breakdown, ~30 derived statistics, filters, and the classic charts.
- **Map**: heatmap of every GPS route (by type, or by frequency), hover/click routes for a card, zoom to street level, Locations / By Month / Timelapse tools. Drawn on canvas, so it stays smooth with hundreds of routes.
- **Duplicate merging**: a workout recorded by both an Apple Watch and Strava is shown once, taking the route, name and distance from Strava and heart rate and energy from Apple.
- **Photo Tour** and **Share as video**, below.
- **Persistence** (IndexedDB), metric / imperial toggle, keyboard-accessible dialogs, reduced-motion support.

Strava routes are read from `.gpx`, `.gpx.gz`, `.fit` and `.fit.gz` files in the export (a built-in FIT decoder), so most Strava activities get a route, not just the few with GPX.

---

## Photo Tour

- Drop in photos and/or videos alongside your workouts
- Each media item is matched to the workout that was underway when it was taken (EXIF timestamp → workout start/end window, adjustable ±0–30 min)
- If the photo has EXIF GPS it's plotted directly; otherwise the position is interpolated from the workout's GPX trackpoints
- Per-workout detail view shows the route, small photo markers on the map, and a full grid of every attached photo — click any tile to open a lightbox and fly the map to that spot
- **Cinema tour mode** — press Play to enter a full-screen tour. The dot traces the entire route in three-phase transits (zoom-out to preview the route slice, animate the dot at a constant pace, zoom in on the next photo). Split screen shows the active photo/video during each hold; the map full-screens during transits. Videos autoplay with sound (falls back to muted + tap-to-unmute if the browser blocks it).
- HEIC images and MP4/MOV videos are supported (HEIC is decoded via lazy-loaded `libheif-js`; MP4/MOV timestamps come from QuickTime atoms via exifr).
- GPS spike filtering: isolated bad GPX readings (classic "point way off course, big detour to reach it") are automatically dropped so the route trace and animations aren't thrown off by a single bad fix.

### Share as video

Every workout's Photo Tour has a **Share** button that renders the animation to a video file you can post. Plays inline in Twitter/X, iMessage, Discord, WhatsApp, and Slack. All rendering happens client-side via the **WebCodecs API** (`VideoEncoder` + a JS WebM muxer) — no server, no wasm build step.

WebCodecs matters here, not just MediaRecorder: every frame gets an **explicit presentation timestamp**, so the exported video always plays back at exactly the duration your settings imply — no speed drift if the browser tab is busy while rendering, no frozen/fast-forwarded sections.

- **Camera style**: *Overview* (whole route always visible) or *Follow the route* (camera tracks the dot at a tighter zoom)
- **Route pacing**: *Steady* (constant distance/second — long GPS-dense rest stops don't stall the animation) or *Real timing* (dot lingers wherever you actually paused, for a more true-to-the-workout feel)
- **Cinematic intro** (optional, default on, 2–5s): camera starts at a state/country-scale view and eases into the route, with your **trip name** as a large title overlay (not a geocoded guess — you type it)
- Sliders for **animation speed** and **photo pause length**; videos in the tour play through their real duration
- Output can be saved as `.webm` or `.mp4` (the `.mp4` option just re-wraps the same bytes with an mp4 container tag — most players sniff the format and don't care about the extension; Instagram's stricter uploader may still reject it)
- Real basemap tiles (Esri's light gray canvas) drawn under the route; moving dot sits exactly on a solid tour polyline (no drift between dot and trace)

---

## Getting your data

| Source | How to export |
|---|---|
| **Strava** | strava.com → Settings → My Account → Download or Delete Your Account → Request Your Archive |
| **Apple Health** | iPhone Health app → profile picture → Export All Health Data |

Load either one, or both. Photos are dragged in loose (JPG / HEIC / MP4 / MOV).

---

## Running locally

No build step, but ES modules need a real server (not `file://`).

```bash
npm install        # only for the tests; the app itself has no dependencies to install
npm run serve      # tiny static server with correct MIME types → http://127.0.0.1:8080
```

`npx serve .` also works. On Windows avoid `python -m http.server`, which serves `.js` as `text/plain`.

### Tests

```bash
npm test           # Node unit tests: parsers, FIT decoder, dedup merge, analysis (synthetic fixtures)
npm run contrast   # WCAG AA check of all six mode × theme palettes
npm run e2e        # real-Chrome smoke test with synthetic exports (skips if Chrome isn't installed)
```

No personal data is committed; every fixture is generated in the test.

---

## Optional: pre-extract photo EXIF (large libraries)

```bash
pip install exifread Pillow
python scripts/prepare_photos.py <your-photo-folder>
```

Next page load, `data/photos.json` is picked up automatically. Matching still runs in the browser.

---

## Architecture

```
index.html              app shell: nav, upload dialog, view containers (stays at the root: GitHub Pages serves it)
src/
  app.js                orchestrator: nav, modes, theme, routing, upload dialog
  core/
    state.js modes.js router.js      shared store + pub/sub, the three modes, hash router
    data/   store.js (IndexedDB)  upload.js  dedup.js (reversible merge)  routes.js (lazy trackpoints)
    lib/    format.js (units + formatters)  util.js  ui.js (toast, dialogs, layout)  collapse.js
  parsers/              strava.js apple.js gpx.js fit.js photos.js model.js (activity model v2)
  analysis/             pure, unit-tested logic with no DOM
    activity/           streams splits efforts yearly trends feed
    health/             rings awards   (nutrition lands here)
    dates.js
  views/                today feed activity awards profile stats-view map-view
  components/           rings, badges, icons, route thumbnails, year summary (SVG, no deps)
  charts/               D3 charts (distance, weekly, hr-zones, records, stats) + stream.js (synced)
  map/                  heatmap.js, route.js, tiles.js
  photos/               matcher, list, detail (cinema tour), HEIC, video export pipeline
  styles/               fonts.css, modes.css (6 variants), views.css
  design-system/        shared theme + activity colours (Okabe-Ito)
vendor/                 Leaflet, JSZip, D3, exifr, libheif, webm-muxer, fonts (self-hosted)
tests/                  mirrors src/ (parsers/, analysis/activity/, analysis/health/)
e2e/  scripts/  docs/   smoke test + static server, contrast check + photo helper, roadmap
```

### Normalized activity model (v2)

Every parser produces the same shape so the UI never touches raw source data.

```javascript
{
  id, source, name, type, sub_type,            // type is one of Run/Ride/Walk/Hike/Swim/Other
  date: Date,
  distance_m, duration_s, moving_s,            // elapsed vs moving time
  elevation_gain_m, calories_kcal,
  avg_heart_rate, max_heart_rate, avg_cadence, avg_watts, max_speed_mps,
  gear, indoor, description, device,
  has_route, route_points, _gpxLoader,         // lazy; points are {lat,lng,ele,time,hr,cad,watts}
  sources: ['strava','apple'],                 // after merge
  merged_into, merged_ids,                     // duplicate merge bookkeeping
  photos: [...]
}
```

---

## Privacy

Everything runs in the browser. No fitness data, no photo bytes and no metadata are sent to any server. All scripts and fonts are served from this site (`/vendor`); a Content-Security-Policy enforces that. The only requests the page makes:

- **Map tiles** from `server.arcgisonline.com` (Esri) and `tile.openstreetmap.org` (street-level zoom), which necessarily reveal the area you're looking at
- *Only if you press "Name these places"* on the Map's Locations tab: one coordinate per area to OpenStreetMap's Nominatim service. It is off by default; places show as coordinates.

Saved data lives in your browser's IndexedDB for this site. **Menu → Delete my data** removes it. Photos are never saved; they're re-read from the files you pick each time.

---

## Tech

Vanilla HTML / CSS / JS (ES modules). Leaflet, D3 v7, JSZip, exifr, libheif-js, all vendored. No framework, no bundler, no build step. `package.json` exists only for the Node tests.
