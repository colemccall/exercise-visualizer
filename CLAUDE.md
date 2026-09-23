# Fitness Visualizer — Claude Code Context

Client-side fitness data visualizer. Upload a Strava or Apple Health export ZIP,
optionally drop in photos/videos. All parsing happens in the browser — no data
ever leaves the device. Shows a route heatmap, charts, and a photo tour that can
be exported as a shareable video.

Live: https://colemccall.github.io/exercise-visualizer/ (GitHub Pages, from `master`).

`README.md` is the user-facing feature description and is accurate — read it for
what the app *does*. This file covers what a contributor needs to know.

## Current State

**Built and working:**
- Persistent top nav with three sibling views: **Map / Stats & Charts / Photos**.
  Upload is a modal (auto-opens on first visit, reachable anytime via "Upload data").
- Collapsible sections everywhere (see "Collapsible panels" below) plus a
  full-screen map mode, so the map can have the whole viewport.
- Two complete themes (light + dark), each independently designed and WCAG AA
  checked — not a token flip over one palette. Activity colors use the
  colorblind-safe Okabe-Ito palette.
- Parsers: `strava.js`, `apple.js`, `gpx.js`, `photos.js`
- Normalized Activity model — every parser emits the same shape
- Dedup: flags the same workout recorded by both sources
- Heatmap (By Type / Frequency styles, each with a legend), Stats / Locations /
  By Month / Timelapse panel
- Charts: monthly distance, weekly calendar, HR zones, personal records,
  per-activity elevation + HR line
- `charts/stats.js`: ~30 derived statistics (volume, consistency, streaks,
  records, heart rate, per-type breakdown), full grid on the Stats view plus a
  compact strip in the map's explore panel
- Photo Tour: EXIF-timestamp → workout matching, GPS interpolation from GPX,
  cinema tour playback, HEIC + MP4/MOV support
- Video export via WebCodecs (`VideoEncoder` + JS WebM muxer), with camera style,
  route pacing, cinematic intro, speed/pause sliders
- Metric/imperial toggle (localStorage, defaults to miles)
- GPS spike filtering

**Validated against real exports** (2026-08-10) — see "Real Test Data" below.
Both sources parse end-to-end and the full Map/Charts flow renders with no
uncaught errors. Four bugs were found and fixed in that pass; see git log.

**Re-validated 2026-09-23** with the Strava export (441 activities, 70 routes)
through Playwright at 1440px, 390px and 375px: both heat styles in both themes,
zoom to z20, full-screen map, every collapse toggle, filters driving the stats,
and the unit toggle. No console errors; `scrollWidth === innerWidth` on both
phone widths.

**Not yet built / known gaps:**
- [ ] Photo Tour cinema view has not been audited on a narrow viewport (the rest
      of the app has — see "Mobile / iOS" below)
- [ ] Web Worker for Apple XML parsing — only needed if a real export freezes the
      tab. It does not today: a 875MB `export.xml` streams in ~4s (see below).
- [ ] Share card (html2canvas summary PNG)

No auth. No data stored between sessions.

## Sources

Strava and Apple Health only. **Garmin is deliberately not supported** — a written
but never-wired-up `parsers/garmin.js` was deleted on 2026-08-10 (it had no drop
zone and was never imported by `app.js`). Don't "restore" it without a real Garmin
export to test against; recover it from git history if it's ever wanted back.

## Tech Stack

Vanilla HTML/CSS/JS. Leaflet + D3 v7 (ESM) + JSZip + exifr + libheif-js via CDN.
No framework, no bundler, no build step.

**Requires a local server** — ES module imports won't work from `file://`:
```bash
npx serve .
```
Avoid `python -m http.server` on Windows — it serves `.js` as `text/plain`, which
breaks module loading.

## Key Files

```
index.html              — app shell, top nav, view markup, upload modal, ALL CSS
app.js                  — state, upload orchestration, dedup, view routing,
                          filters, activity list, explore panel, timelapse
design-system/
  theme.css             — shared design system (also used by sibling apps)
  activity-colors.js    — single source of truth for activity-type colors
  fitness-theme.md      — this app's two-theme token reference
parsers/
  gpx.js                — shared GPX trackpoint parser (DOMParser-based)
  strava.js             — activities.csv + lazy GPX from ZIP
  apple.js              — streamed export.xml + workout-routes/*.gpx
  photos.js             — EXIF via exifr (photos + video atoms)
charts/
  stats.js              — derived statistics (computeStats + two renderers)
  distance.js           — monthly distance, stacked by type
  weekly.js             — weekly activity calendar
  hr-zones.js           — % time in 5 HR zones
  elevation.js          — elevation profile + HR line (detail view)
  records.js            — personal records
map/
  heatmap.js            — multi-route Leaflet layer
  route.js              — single route, colored by pace or HR
photos/
  matcher.js            — pair photos to workouts, interpolate GPS from GPX time
  list.js               — workouts-with-photos list
  detail.js             — route + photo grid + cinema tour + share modal
  heic.js               — lazy libheif-js decoder
  video.js              — first-frame poster capture
  composite.js          — per-frame drawing (tiles + route + dot + media + intro)
  export.js             — video render pipeline (timeline, WebCodecs, spike filter)
scripts/
  prepare_photos.py     — optional offline EXIF extractor
coi-serviceworker.js    — retired; MP4 export no longer needs COI headers
```

## Normalized Activity Model

Every parser returns this — the UI never reads raw source data:
```javascript
{
  id: String,                    // "strava-12345678"
  source: "strava"|"apple",
  name: String,
  type: "Run"|"Ride"|"Walk"|"Hike"|"Swim"|"Other",
  date: Date,                    // always a real instant — see timezone note below
  distance_m: Number,            // always meters internally
  duration_s: Number,            // always seconds
  elevation_gain_m: Number|null,
  avg_heart_rate: Number|null,
  max_heart_rate: Number|null,
  has_route: Boolean,
  gpx_file: String|null,         // ZIP-internal path
  route_points: null,            // populated on demand
  _gpxLoader: async () => Point[], // lazy route loader, attached by the parser
  has_duplicate: false,          // set by dedup logic in app.js
  photos: [...],                 // attached by photos/matcher.js
}
```

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

## Collapsible Panels

Anything carrying `data-collapse="<key>"` is a toggle. The section it folds is
its closest `.panel` / `.chart-card` / `#explore-panel` ancestor, which gets the
`collapsed` class; CSS then hides that section's `.collapsible-body`. State is
persisted per key under `fitness-collapsed:<key>`, because the usual reason to
collapse something here is "leave the map big" and that shouldn't reset on
reload. `initCollapsibles()` in `app.js` wires all of it, including the chart
cards (keyed by their chart div's id) and the "Collapse all sections" button.

**D3 charts must be re-drawn after expanding.** They size to
`container.clientWidth`, which is 0 while the section is hidden, and fall back
to a placeholder width. `redrawCharts()` is called when a card or the charts
panel expands and when the Stats view becomes visible — don't remove those
calls, the charts come back stretched otherwise.

Full-screen map (`body.map-fullscreen`, the "Expand map" button, `F`, `Esc`)
sizes the map to `100dvh - var(--nav-h)`. `--nav-h` is measured in JS after the
class is applied, not hard-coded: the nav wraps to two rows below 700px and
full-screen mode drops the brand from it.

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
count along its path. Routes are then colored by percentile rank on a
theme-specific sequential ramp, with weight and opacity also scaling with the
score, and the hottest routes raised to the front.

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

Audited on 2026-08-10 at iPhone 13 (390px), iPhone SE (375px), and landscape.

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
- **Nav** wraps to two rows below 700px; the "Upload data" label is hidden (icon +
  `aria-label` remain).
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

Two levels, both worth doing:

1. **Parsers headless in Node.** Copy `parsers/*.js` to a scratch dir, add a
   `package.json` with `{"type":"module"}` so Node treats them as ESM, then shim
   the two browser globals they assume:
   ```javascript
   global.JSZip = JSZip;                              // npm jszip
   global.DOMParser = new JSDOM('').window.DOMParser; // npm jsdom
   ```
   A Node `Buffer` with a `.name` property works in place of a `File`. Fast to
   iterate, and lets you assert on counts/dates directly.

2. **Real browser.** Chrome is installed locally, so `playwright-core` can drive
   it without downloading a browser:
   ```javascript
   chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
   ```
   Feed the real ZIPs through `#file-strava` / `#file-apple` with
   `setInputFiles`, click **Analyze →**, then wait on `.stats-bar` having digits.
   Watch for zero-size Leaflet containers — `invalidateSize()` cannot rescue an
   element whose CSS height resolves to 0.

   The heatmap's Leaflet instance is exposed as `window.__heatmapMap` for
   exactly this — `setZoom`/`setView` it directly rather than clicking the zoom
   control N times.

   Useful assertions: route strokes are plain SVG paths under `#heatmap`, so
   `getAttribute('stroke')` tells you what a heat style actually painted, and
   `document.documentElement.scrollWidth` vs `window.innerWidth` is the mobile
   overflow check from "Mobile / iOS".

---

## Remaining Work (Ordered)

1. **Photo Tour + video export against real photos** — the photo pipeline and
   WebCodecs export have not been exercised in either validation pass (only
   workouts were). Use the GPX folder plus a real camera roll. Check the cinema
   tour on a phone while you're there; it's the one surface the mobile pass
   didn't cover. Note `photos/composite.js` changed basemap provider on
   2026-09-23 (CARTO → Esri, see "Basemaps and Zoom"); exported frames have not
   been eyeballed since.
2. **Verify on a physical iPhone** — real Files-app upload and Safari memory on a
   large Apple Health ZIP. Emulation can't answer either.
3. Web Worker for Apple parsing — only if a real export is measured to freeze.
4. Share card (html2canvas summary PNG).
