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
- Strava routes from `.gpx`, `.gpx.gz`, `.fit`, `.fit.gz` (own FIT decoder, `parsers/fit.js`).
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
      `photos/composite.js` basemap provider changed 2026-09-23). The cinema view isn't audited narrow.
- [ ] Physical iPhone: real Files-app upload, Safari memory on a large Apple ZIP.
- [ ] Web Worker for parsing — only if a real export is measured to freeze. FIT decode of all 375
      routes takes ~12s on the main thread (chunked with yields; single routes are tens of ms).
- [ ] Share card (html2canvas PNG); Phase 2 ideas in docs/ROADMAP.md.
- [ ] Awards titles are miles-based English strings from `analysis/awards.js`; progress text honours units.

No auth. Data is stored only in this browser (IndexedDB), never sent anywhere.

## Sources

Strava and Apple Health only. **Garmin is deliberately not supported** — a written
but never-wired-up `parsers/garmin.js` was deleted on 2026-08-10 (it had no drop
zone and was never imported by `app.js`). Don't "restore" it without a real Garmin
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
index.html            shell: nav, upload dialog, view containers, legacy view CSS (Map/Stats/Photos)
app.js                orchestrator only: nav + mode switch + theme + routing + upload dialog
core/                 state (store + pub/sub), modes, router, store (IndexedDB), upload, dedup,
                      format (units), routes (lazy loading), ui (toast/modal/layout), collapse, util
parsers/              strava, apple, gpx, fit, photos, model (createActivity)
analysis/             PURE logic, unit-tested, no DOM: streams, splits, efforts, yearly, trends,
                      rings, awards, feed, dates
views/                today, feed, activity, awards, profile, stats-view, map-view
components/           rings, badge, icons, thumb (route SVG), year-summary
charts/               D3: distance, weekly, hr-zones, records, stats, stream (synced), tooltip
map/                  heatmap (canvas), route (single route + scrub marker), tiles (shared basemap)
photos/               matcher, list, detail, heic, video, composite, export
styles/               fonts.css, modes.css (tokens for 6 variants + nav), views.css
vendor/               third-party code and self-hosted fonts
design-system/        theme.css (shared with sibling apps), activity-colors.js, fitness-theme.md
tests/ e2e/ scripts/  unit tests, smoke test + static server, check-contrast.mjs, prepare_photos.py
```

## Normalized Activity Model (v2)

Every parser returns this (`parsers/model.js createActivity()`); the UI never reads raw source data.
See README for the field list. Things that are easy to get wrong:

- `duration_s` is *elapsed* time; `moving_s` is moving time (Strava Moving Time; Apple: same as duration).
  Show `moving_s || duration_s` and label it honestly.
- `sources` is `['strava']`, `['apple']` or both after a merge. `merged_into` is set on the *secondary*
  record; everything user-facing must skip records with `merged_into` (`state.scoped()` does).
- Route points are `{lat,lng,ele,time,hr,cad,watts}`; `route_points` is lazy — always go through
  `core/routes.js ensureRoute()`. FIT tracks have GPS dropouts, so raw haversine over points can exceed the
  session distance; splits/charts use the smoothing in `analysis/streams.js`.

### Timezone gotcha (bit us once — don't regress it)

Strava's `activities.csv` writes `"Apr 22, 2026, 3:14:03 AM"` with **no timezone
marker, and the value is UTC**. Handing that to `new Date()` reads it as *local*
time and shifts every activity by the viewer's UTC offset — enough to move
late-evening workouts to the next day and to break cross-source dedup entirely
(dedup only pairs activities within 10 minutes). `parsers/strava.js` has
`parseStravaDate()` for this; it's verified against the Z-suffixed `<time>` of the
first GPX trackpoint, which agrees to the second.

### Apple route attachment

Routes attach **only** via the `<FileReference>` inside each `<Workout>`. There is
deliberately no "match a route by date" fallback: route filenames carry the
workout's *creation* date in local time, so matching them to a workout's UTC
calendar day mislabels — and it only ever fired for workouts that genuinely have
no route (yoga, strength), handing them someone else's GPS trace.

## Modes (Hybrid / Apple / Strava)

`core/modes.js` is a registry: each mode has a nav list, a landing view and a source scope. A mode is
only a *shell* (nav, landing, type, radius, density, which activities are in scope) — it never touches
parsing. The app defaults to **hybrid**; `restoreMode()` only honours a saved mode while its source is
still loaded. `body[data-mode]` + `html.dark-mode` select one of six token sets in `styles/modes.css`.

- Add/rename a nav entry: `core/modes.js`. Add a view: a `<section data-view>` in `index.html`, a renderer in
  `app.js` `renderers`, and a module in `views/`.
- Colour tokens: `--page --card --card-2 --accent --on-accent --ring-* --font-display --font-num`.
  **Use `--on-accent` for text on accent fills** (white fails AA on the dark accents). After touching a
  palette run `npm run contrast`.
- Rendering is lazy: events (`data filters units theme mode`) mark every view dirty and only the visible
  one re-renders; the Map view and Activity page always re-render on show.
- Stats-style numbers must use `moving_s`, units must go through `core/format.js`.
- "Now" for trends / this-week is `dataAnchor()` — an export is a snapshot, so if the newest activity is
  >3 weeks old it anchors there instead of today (otherwise "last 90 days" is empty).

## Data flow & persistence

`core/upload.js parseStaged()` → parse each source → **save raw activities to IndexedDB (before merging;
merging mutates)** → `rebuildMerge()` (`core/dedup.js`, reversible via `_premerge`) → `emit('data')`.
`saveRoutesInBackground()` then decodes every route once and stores it packed in typed arrays
(`core/store.js`), so the next visit's `_gpxLoader` reads from IndexedDB. `restoreSaved()` runs at boot.
Photos are never persisted. Bumping `SCHEMA` in `core/store.js` discards older saved data.

## Collapsible Panels

Anything carrying `data-collapse="<key>"` is a toggle (`core/collapse.js`); the section it folds is its
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

The tools strip is collapsed by default (`COLLAPSED_BY_DEFAULT` in `app.js`);
clicking any of its tabs opens it rather than switching a hidden pane.

## Route Selection

Routes are the content, so they behave like it: `setRouteHandlers()` in
`map/heatmap.js` takes `onHover`/`onSelect` from `app.js`, which owns the card
UI. `highlightRoute()` draws a casing in the page background colour plus the
route in its own colour — two lines rather than one thick one, so the highlight
reads against both a dense cluster and an empty map. The click handler calls
`L.DomEvent.stopPropagation`, otherwise the map's own click handler (which
clears the selection) fires immediately after. Selection is a pointer at one
activity, deliberately independent of the filters.

## Basemaps and Zoom

Two stacked tile layers in `map/heatmap.js` (and the same pair in
`map/route.js`):

- **z0-16** Esri `World_Light_Gray_Base` — the neutral canvas routes read best
  against. Its tiles simply stop at z16.
- **z17-20** OpenStreetMap standard tiles — native to z19, upscaled one step to
  z20. This is what makes street-level zoom possible; the map used to refuse to
  go past z16.

**Do not use `basemaps.cartocdn.com`.** It now stamps "API KEY REQUIRED" across
keyless tiles — that is why `photos/composite.js` (video export) was switched to
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
in `app.js` (charts receive `units`; `charts/stats.js` receives the whole `fmt`
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

Import from `design-system/activity-colors.js` — do not redeclare these:
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
