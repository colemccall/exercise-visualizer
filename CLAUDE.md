# Fitness Visualizer — Claude Code Context

Client-side fitness data visualizer. Upload a Strava or Apple Health export ZIP,
optionally drop in photos/videos. All parsing happens in the browser — no data
ever leaves the device. Shows a route heatmap, charts, and a photo tour that can
be exported as a shareable video.

Live: https://colemccall.github.io/exercise-visualizer/ (GitHub Pages, from `master`).

`README.md` is the user-facing feature description and is accurate — read it for
what the app *does*. This file covers what a contributor needs to know.

## Current State

**Rebuilt 2026-10-27** (Phase 0 + 1 of docs/ROADMAP.md). What exists:

- **Three experiences by dataset** — Hybrid (default), Apple, Strava — each in light (default) and
  dark: six designed variants, WCAG AA-checked by `npm run contrast`. See "Modes" below.
- Views: **Today/Summary** (rings, trends, awards, recent), **Feed/Workouts**, **Activity page**
  (`#/activity/<id>`: splits, best efforts, synced stream charts), **Map**, **Awards**, **Profile**
  (yearly stats), **Stats** (the legacy ~30 statistics, filters, D3 charts), **Photos** (Photo Tour).
- IndexedDB persistence; a reload restores data without re-parsing. "Delete my data" in the menu.
- Duplicate workouts across Strava and Apple are **merged**, not just flagged.
- Strava routes from `.gpx`, `.gpx.gz`, `.fit`, `.fit.gz` (own FIT decoder, `src/parsers/fit.js`).
  The real export is mostly FIT: before the decoder only 67 of 441 activities had a route; now 375.
- All third-party code is vendored under `vendor/`; a CSP meta tag forbids anything else.
- Unit tests (`npm test`), contrast check, and a real-Chrome smoke test (`npm run e2e`).

Validated against the real exports on 2026-10-27 through Playwright at 1440px and 390/375px, all
three modes, both themes: no console errors, `scrollWidth === innerWidth` on every view.

Note on "it didn't change after a push": GitHub Pages serves `index.html` with
`cache-control: max-age=600` and browsers cache ES modules aggressively, so a deploy can take ten
minutes to show up — or need a hard reload. Confirm what is actually live by fetching the file
(`curl .../views/feed.js`) before chasing a bug that is really a cached build.

**Known gaps:**
- [ ] Photo Tour + video export against real photos and a phone (not exercised in any pass;
      `src/photos/composite.js` basemap provider changed 2026-09-23). The cinema view isn't audited narrow.
- [ ] Physical iPhone: real Files-app upload, Safari memory on a large Apple ZIP.
- [ ] Web Worker for parsing — only if a real export is measured to freeze. FIT decode of all 375
      routes takes ~12s on the main thread (chunked with yields; single routes are tens of ms).
- [ ] Share card (html2canvas PNG); Phase 2 ideas in docs/ROADMAP.md.
- [ ] Awards titles are miles-based English strings from `src/analysis/health/awards.js`; progress text honours units.

No auth. Data is stored only in this browser (IndexedDB), never sent anywhere.

## Sources

Strava and Apple Health only. **Garmin is deliberately not supported** — a written
but never-wired-up `src/parsers/garmin.js` was deleted on 2026-08-10 (it had no drop
zone and was never imported by `src/app.js`). Don't "restore" it without a real Garmin
export to test against; recover it from git history if it's ever wanted back.

## Tech Stack

Vanilla HTML/CSS/JS (ES modules). Leaflet + D3 v7 + JSZip are classic `<script>` tags from `vendor/`
(globals `L`, `d3`, `JSZip`); exifr, libheif-js and webm-muxer are vendored and dynamically imported.
No framework, no bundler, no build step. `package.json` exists only for the Node tests (jsdom, jszip,
playwright-core as dev deps).

**Requires a local server** — ES module imports won't work from `file://`:
```bash
npm run serve        # e2e/server.mjs: correct MIME types, http://127.0.0.1:8080
```
Avoid `python -m http.server` on Windows — it serves `.js` as `text/plain`, which breaks module loading.

**CSP**: `index.html` has a Content-Security-Policy meta tag (`default-src 'self'`, tiles from Esri/OSM,
Nominatim for the opt-in place names). Adding a new external host means editing that tag, deliberately.

## Key Files

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

## Normalized Activity Model (v2)

Every parser returns this (`src/parsers/model.js createActivity()`); the UI never reads raw source data.
See README for the field list. Things that are easy to get wrong:

- `duration_s` is *elapsed* time; `moving_s` is moving time (Strava Moving Time; Apple: same as duration).
  Show `moving_s || duration_s` and label it honestly.
- Added in v2.1 (null until a fresh import): `relative_effort`, `elevation_loss_m`, `steps`, `avg_speed_mps`, `avg_mets`,
  `time_zone`, `external_id`, `weather {temp_c, feels_c, humidity_pct, wind_mps}`. Strava's "Weather Condition" is an opaque
  numeric code, so it is deliberately not interpreted. Saved data records which parser wrote it (`MODEL` in
  `core/data/store.js`); older data triggers a one-time "re-upload" hint.
- **Apple `duration_s` is elapsed (end − start); `moving_s` is Apple's active `duration`** (pauses excluded), matching Strava's meaning.
- Apple writes `HKExternalUUID = strava://activities/<id>` on workouts that Strava put into Health; `core/data/dedup.js`
  merges those on the id alone before the 10-minute heuristic.
- `sources` is `['strava']`, `['apple']` or both after a merge. `merged_into` is set on the *secondary*
  record; everything user-facing must skip records with `merged_into` (`state.scoped()` does).
- Route points are `{lat,lng,ele,time,hr,cad,watts}`; `route_points` is lazy — always go through
  `src/core/data/routes.js ensureRoute()`. FIT tracks have GPS dropouts, so raw haversine over points can exceed the
  session distance; splits/charts use the smoothing in `src/analysis/activity/streams.js`.

### Timezone gotcha (bit us once — don't regress it)

Strava's `activities.csv` writes `"Apr 22, 2026, 3:14:03 AM"` with **no timezone
marker, and the value is UTC**. Handing that to `new Date()` reads it as *local*
time and shifts every activity by the viewer's UTC offset — enough to move
late-evening workouts to the next day and to break cross-source dedup entirely
(dedup only pairs activities within 10 minutes). `src/parsers/strava.js` has
`parseStravaDate()` for this; it's verified against the Z-suffixed `<time>` of the
first GPX trackpoint, which agrees to the second.

### Apple route attachment

Routes attach **only** via the `<FileReference>` inside each `<Workout>`. There is
deliberately no "match a route by date" fallback: route filenames carry the
workout's *creation* date in local time, so matching them to a workout's UTC
calendar day mislabels — and it only ever fired for workouts that genuinely have
no route (yoga, strength), handing them someone else's GPS trace.

## Modes (Hybrid / Apple / Strava)

`src/core/modes.js` is a registry: each mode has a nav list, a landing view and a source scope. A mode is
only a *shell* (nav, landing, type, radius, density, which activities are in scope) — it never touches
parsing. The app defaults to **hybrid**; `restoreMode()` only honours a saved mode while its source is
still loaded. `body[data-mode]` + `html.dark-mode` select one of six token sets in `src/styles/modes.css`.

- Add/rename a nav entry: `src/core/modes.js`. Add a view: a `<section data-view>` in `index.html`, a renderer in
  `src/app.js` `renderers`, and a module in `views/`.
- Colour tokens: `--page --card --card-2 --accent --on-accent --ring-* --font-display --font-num`.
  **Use `--on-accent` for text on accent fills** (white fails AA on the dark accents). After touching a
  palette run `npm run contrast`.
- Rendering is lazy: events (`data filters units theme mode`) mark every view dirty and only the visible
  one re-renders; the Map view and Activity page always re-render on show.
- Stats-style numbers must use `moving_s`, units must go through `src/core/lib/format.js`.
- "Now" for trends / this-week is `dataAnchor()` — an export is a snapshot, so if the newest activity is
  >3 weeks old it anchors there instead of today (otherwise "last 90 days" is empty).

## Rings (what the numbers mean)

`analysis/health/rings.js`: `ringsForDay` for one day; `periodRingTotals(summaries, from, to)` for cumulative rings.
Rules that matter (verified against a real export whose Move goal changed 290→1000 and whose Exercise/Stand goals were
0 until mid-2025): goals are **summed per day**, never "today's goal × days"; days with no goal for a ring are left out of
that ring's goal and of the progress used for the percentage (but still count toward the total); a day with a summary and
zero progress is an **open ring**, a day without a summary adds nothing and is reported as missing; a period still in
progress is capped at the newest data day (`periodBounds`). `monthRings` returns full ring objects (it once returned bare
percentages, which rendered every day empty). Streaks count back from the newest data day, not today.

## Search, filters and drill-downs

One filter object (`state.filters`, shape = `emptyFilters()` in `src/core/lib/query.js`) is the only definition of "what am I looking at".
`activityMatches()` / `filtered()` / `sortActivities()` in `core/state.js` apply it; Feed, Stats, Map, Explore and the Plan's history all go
through them. The search box, filter chips, chart drill-downs and URL are four views of that one object:

- `parseQuery(text)` / `formatQuery(filters)` / `queryTokens(filters)` (pure, 11 tests) are the language; `queryTokens` also feeds
  `describeFilters()`, i.e. the removable chips, so chips and text can never disagree. Unknown "word:" tokens stay plain text; a
  recognised key with a bad value is an error chip, never silently ignored. The internal month key is "YYYY-<0-based month>".
- `#/feed?q=…`: `core/router.js` carries `q`; `app.js` applies a link's query on arrival and `replaceQuery()`s it as filters change
  (no history spam). A link without `q` leaves the current filters alone.
- Drill-downs are just searches: put `data-drill="type:run year:2025"` on any element (`core/drill.js`, one delegated handler).
- `views/search.js` (the bar, saved searches in localStorage), `views/explore.js` (sortable table + CSV).

## Map

`views/map-view.js`. `matchingIds()` = filtered() ∩ the drawn area; `applyHeatmapFilter()` dims everything else, re-scores **frequency over the
matching set only**, and refreshes the filter bar, legend and Activities list. Overview polylines are Douglas-Peucker simplified to ≤3000
vertices (`map/heatmap.js`); the pinned route is drawn from full points. Canvas hit tolerance is widened on `pointer: coarse`; a click
also lists every other route under the point (`routesAt`, uses Leaflet's private `_containsPoint`: re-check on Leaflet upgrades).
Basemaps live in `map/tiles.js` (light/dark/terrain/satellite, persisted); **provider terms are documented there and need a manual
check before relying on them at scale** (Esri keyless use, OSM tile policy, OpenTopoMap). New tile hosts must also be added to the CSP
in `index.html`. On ≥1100px the tools strip is a side panel (open by default); under that it is the folded bottom strip.

## Plan (nutrition, goals, targets)

`src/analysis/health/nutrition.js` is the engine (pure, unit-tested; kg/cm/kcal/m/s internally); `src/views/plan.js` is inputs +
presentation; `src/core/data/plan-store.js` is the model and persistence (`state.plan`, IndexedDB store `plan`, DB_VERSION 2, which
only *adds* the store).

- Model: `balance/day = intake − (base burn + exercise)`; weight change/week = balance × 7 / 7700. **Base burn = BMR + non-exercise
  movement**; with an Apple export both come from the user's own data (median basal energy; daily Move minus that day's workout kcal),
  else Mifflin–St Jeor × a baseline factor. `planTargets()` solves *required exercise = intake − base − required balance*, then
  `exerciseTargets()` turns kcal into minutes/sessions/distance using the user's own kcal-per-minute and kcal-per-metre by type.
- Weight is smoothed by a **time-aware** EWMA (tau 7 days): an entry-count EMA once reported 179 lb for someone whose latest
  weigh-in was 202 lb. The projection starts *today* from the smoothed weight, not from the last weigh-in.
- Guardrails are part of the model: no deficit under 18, loss rate capped at 1% of bodyweight/week (warn above 0.75%), intake
  floor (1200 F / 1500 M), protein 1.6–2.2 g/kg check, "ambitious" flag at >2× recent weekly exercise, and a peak-week conflict when
  the training plan + deficit leaves too little to eat. Copy says "planning estimates, not medical advice".
- Apple health inputs (`parsers/apple.js createHealthCollector`): `<Me>` → birth **year** + sex only; BodyMass, Height, Basal energy,
  Dietary energy/macros. Basal/dietary take the *largest source per day* (no double counting, survives a device change). Active
  energy is deliberately *not* summed from records (ActivitySummary Move is authoritative). Adds ~4s to parsing a ~900MB export
  (~8s total in Node). Nothing is applied to the plan until the user presses "Fill from Apple Health".
- Plan edits are saved with a short debounce **and flushed on pagehide/visibilitychange** (a plain debounce loses the last edits on reload).
- Dates typed by users are parsed by components (`new Date('2026-03-01')` is UTC midnight and shifts a day west of Greenwich).

## Data flow & persistence

`src/core/data/upload.js parseStaged()` → parse each source → **save raw activities to IndexedDB (before merging;
merging mutates)** → `rebuildMerge()` (`src/core/data/dedup.js`, reversible via `_premerge`) → `emit('data')`.
`saveRoutesInBackground()` then decodes every route once and stores it packed in typed arrays
(`src/core/data/store.js`), so the next visit's `_gpxLoader` reads from IndexedDB. `restoreSaved()` runs at boot.
Photos are never persisted. Bumping `SCHEMA` in `src/core/data/store.js` discards older saved data.

## Collapsible Panels

Anything carrying `data-collapse="<key>"` is a toggle (`src/core/lib/collapse.js`); the section it folds is its
closest `.panel` / `.chart-card` / `#explore-panel`, which gets `collapsed`. State persists under
`fitness-collapsed:<key>`. **D3 charts must be re-drawn after expanding** (they size to
`container.clientWidth`, 0 while hidden): `initCollapsibles(onChange)` is wired to `redrawCharts()`, and
a ResizeObserver on `#view-charts` redraws on width changes. Charts must never be wider than their
container: grid items need `min-width: 0` / `minmax(0,1fr)` or an over-wide SVG stretches the whole page
(this bit twice: the weekly calendar and a 53-cell year strip).

## Map View Layout

`#heatmap-explore-wrapper` has a *definite* height — `100dvh - var(--nav-h)` —
which is what lets the map take `flex: 1` and the tools strip size to its
content. With `height: auto` there, flex-basis governs the map's height,
`#heatmap { height: 100% }` resolves to auto, every absolutely-positioned
Leaflet pane collapses, and the Map view renders blank. That trap is why the map
used to be pinned to `60vh`.

`--nav-h` is everything stacked above the map — the nav plus the duplicate
banner when it's showing — measured in JS (`syncNavHeight`), never hard-coded:
the nav wraps to two rows below 700px, full-screen mode drops the brand from it,
and the banner comes and goes. Call it after anything that changes that chrome.
`body.view-map-active` sets `overflow: hidden`, since the view is exactly one
viewport tall and shouldn't also scroll.

The tools strip is collapsed by default (`COLLAPSED_BY_DEFAULT` in `src/app.js`);
clicking any of its tabs opens it rather than switching a hidden pane.

## Route Selection

Routes are the content, so they behave like it: `setRouteHandlers()` in
`src/map/heatmap.js` takes `onHover`/`onSelect` from `src/app.js`, which owns the card
UI. `highlightRoute()` draws a casing in the page background colour plus the
route in its own colour — two lines rather than one thick one, so the highlight
reads against both a dense cluster and an empty map. The click handler calls
`L.DomEvent.stopPropagation`, otherwise the map's own click handler (which
clears the selection) fires immediately after. Selection is a pointer at one
activity, deliberately independent of the filters.

## Basemaps and Zoom

Two stacked tile layers in `src/map/heatmap.js` (and the same pair in
`src/map/route.js`):

- **z0-16** Esri `World_Light_Gray_Base` — the neutral canvas routes read best
  against. Its tiles simply stop at z16.
- **z17-20** OpenStreetMap standard tiles — native to z19, upscaled one step to
  z20. This is what makes street-level zoom possible; the map used to refuse to
  go past z16.

**Do not use `basemaps.cartocdn.com`.** It now stamps "API KEY REQUIRED" across
keyless tiles — that is why `src/photos/composite.js` (video export) was switched to
the Esri tiles too; the watermark was being baked into exported frames.

Dark mode does not swap providers. `html.dark-mode .leaflet-tile-pane` inverts
the tiles in CSS, which gives every Leaflet map in the app a dark basemap at
every zoom for free. Routes live in the overlay pane and keep their real colors.

`coreBounds()` frames the initial view on the densest ~25km cell plus an ~80km
radius instead of fitting every point. Fitting everything opened the map at
continent scale for anyone who has travelled, with their real routes as specks.
Routes outside that frame are still drawn — zoom out and they're there. Once the
user pans or zooms (`_userMovedMap`), the map stops re-framing itself.

## Frequency Heat Style

`computeFrequency()` bins every trackpoint onto a ~78m grid, counts how many
*separate activities* touch each cell (one increment per activity per cell, so
laps within one workout don't inflate it), and scores each route by the median
count along its path. Colour position blends percentile rank (spreads the
palette evenly over the routes you actually have) with a log scale of the raw
count (keeps the colour tied to "how many times"), with weight and opacity also
scaling, and the hottest routes raised to the front.

Both ramps stay saturated at *both* ends, and opacity floors at 0.7. A pale or
near-grey low end reads as "the map is washing my routes out" rather than "I
rarely go here" — the colour carries the reading, opacity and weight only add
emphasis.

The previous implementation drew every route in one flat color at 0.12-0.15
opacity and relied on overlap to darken — invisible for any route travelled
once, and in dark mode a white stroke on the (then light) basemap, i.e. nothing
at all. If you change the ramps, check both themes against a real export; the
legend in the map's bottom-left reports the actual visit counts.

## Units

Miles are the default. `fitness-units` alone is not trusted at startup — an
earlier build wrote a value into it on load, so a stored preference only counts
when `fitness-units-explicit` is `'1'`, which `setUnits()` sets on a real click
of the km/mi toggle. Every user-visible distance must go through the formatters
in `src/app.js` (charts receive `units`; `src/charts/stats.js` receives the whole `fmt`
bundle). A hardcoded `km` slipped into the weekly calendar's tooltip that way.

## Mobile / iOS

Audited 2026-08-10 and re-checked 2026-10-27 after the rebuild at 390px and 375px.

**The rule that matters: nothing may be wider than the viewport.** When any element
overflows horizontally, mobile browsers shrink the *entire page* to fit — the app
renders at ~60% scale and every tap target shrinks with it. This happened for real:
the top nav packed ~635px of content into a 390px bar. If the app ever looks
"zoomed out" on a phone, measure `document.documentElement.scrollWidth` against
`window.innerWidth` and find the offender; don't reach for `initial-scale`.

Traps already handled — don't undo them:
- **The explore tab strip is `flex-shrink: 0`** for the desktop column layout.
  With four tabs plus the "Hide panel" button that pushed the last tab off the
  clipped edge of the panel on a 390px screen; the mobile rule restores
  shrinking and wrapping.
- **Nav**: under 760px the tabs become a fixed bottom tab bar (icons + labels) and the top bar keeps
  brand mark, mode switch, theme and menu. `--nav-h` and `--tabbar-h` are measured in JS
  (`syncNavHeight`); the Map view is `100dvh - nav - tabbar`.
- **Charts grid** needs `grid-column: 1 / -1 !important` on the cards. Two carry an
  inline `grid-column: span 2`, which outranks any stylesheet rule, and the grid
  then invents an implicit column that collapses a sibling card to ~40px.
- **Upload modal**: `#upload-screen` is a flex item, so `min-width: auto` pinned it
  to its content's 440px min-content width until `min-width: 0` was set.
- **Form fields need `font-size: 16px`** on coarse pointers. Below 16px, iOS Safari
  zooms the page in on focus and never zooms back out.
- **`100dvh`** (with a `100vh` fallback) on the cinema/fullscreen tour — plain `vh`
  is clipped by iOS Safari's collapsing toolbar.
- **`accept` needs MIME types, not just extensions.** The iOS Files picker resolves
  `accept` to UTIs and greys out ZIP files when given bare `.zip`.
- Tap targets are 44px minimum under `@media (pointer: coarse)` per Apple's HIG.

Caveat: this was verified in Chrome's iOS emulation, which matches layout but not
the real WebKit engine. Untested on a physical iPhone: actual Files-app upload,
and Safari's per-tab memory ceiling on a large Apple Health ZIP.

## Apple Health Performance

`apple.js` streams `<Workout>` blocks out of the ZIP entry via JSZip's
`internalStream`, keeping only a small carry-over buffer — the full XML is never
decompressed into a JS string (Apple exports can exceed the ~1GB string limit).
Measured: **875MB `export.xml` → 402 activities in ~3.6s.** A Web Worker is not
currently needed.

## Activity Type Colors

Import from `src/design-system/activity-colors.js` — do not redeclare these:
```javascript
Run: '#D55E00'  Ride: '#0072B2'  Walk: '#009E73'
Hike: '#E69F00' Swim: '#56B4E9'  Other: '#8A8D99'
```
Okabe-Ito palette — stays distinguishable under protanopia, deuteranopia, and
tritanopia. Same hex values in both themes.

## Real Test Data

Real export ZIPs live at `c:\Projects\VibeCoding\Workout-Maps\`:
- `export-2.zip` (~58MB) — **Apple Health** (875MB export.xml, 402 workouts, 330 routes)
- `export-3.zip` (~58.4MB) — Apple Health (332 routes)
- `early july export.zip` — Apple Health (435 routes)
- `export_105992264.zip` (~11.9MB) — **Strava** (441 activities, 67 GPX)
- `Mix of Apple Watch and Strava GPX\` — loose GPX for quick parser checks

Note `export_105992264.zip` is a Strava export, not Garmin as previously assumed.

### Testing approach

1. **`npm test`** — Node unit tests over synthetic fixtures (`tests/parsers`, `tests/analysis`). Parsers run
   headless with the two browser globals shimmed in `tests/parsers/fixtures.js` (JSZip, jsdom's DOMParser);
   a Node `Buffer` with a `.name` stands in for a `File`. No personal data is ever committed.
2. **`npm run e2e`** — `e2e/smoke.mjs`: real Chrome (playwright-core, no download — uses the installed
   Chrome via `executablePath`), synthetic exports, covers upload → hybrid/light defaults → merge → activity
   page → modes → dark → reload-restores → 390px overflow → delete.
3. **Real exports, by hand**: drive the app with `setInputFiles` on `#file-strava` / `#file-apple`, click
   `#btn-go`, wait for `#app-nav.visible`. Block map tiles with `page.route` for speed. Handy: `window.__heatmapMap`
   is the Leaflet instance; route strokes are canvas now (not SVG paths), so test with map state, not `stroke`
   attributes. The mobile overflow check is `document.documentElement.scrollWidth - innerWidth`; when it fails,
   list elements whose `getBoundingClientRect().right` exceeds the viewport.

---

## Remaining Work (Ordered)

1. **Photo Tour + video export against real photos**, and the cinema tour on a phone. Not exercised in
   any pass. Check exported frames after the 2026-09-23 basemap change.
2. **Physical iPhone**: real Files-app upload; Safari memory on a large Apple ZIP (routes for ~800 activities
   are held in memory — consider decimating for display).
3. Phase 2 from docs/ROADMAP.md: photo story replay, offline PWA + encrypted backup, coverage exploration
   (needs street data), cross-source analytics, year-in-review card.
4. Web Worker for parsing, only if measured to freeze.
