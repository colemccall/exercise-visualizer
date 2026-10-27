# Fitness Visualizer — Roadmap

## Status (2026-10-27): Phase 0 and Phase 1 implemented

| Milestone | State | Notes |
|---|---|---|
| M0 Foundation | **done** | Parser bugs fixed (bare `.xml`, gzip routes, type mapping, moving time, stable ids, photo-only upload). `app.js` split into `core/` + `views/`; shared `escapeHtml`/`haversine`/tooltip/tiles; unit tests, contrast check, Chrome smoke test, CI; everything vendored, CSP, self-hosted fonts; privacy copy corrected; place naming is opt-in. |
| M1 Data layer | **done** | IndexedDB persistence (activities, ring summaries, packed routes), model v2, reversible duplicate **merge**, canvas heatmap. |
| M2 Mode framework | **done** | `core/modes.js`, 3 modes × 2 themes, default hybrid + light, switcher disables modes without data. |
| M3 Strava mode | **done** | Feed, activity page (splits, best efforts + PRs, synced charts), Profile with yearly stats. Added a FIT decoder, which took Strava routes from 67 to 375 of 441. |
| M4 Apple mode | **done** | Summary with rings (day/week/month), trends, awards, workouts. |
| M5 Hybrid mode | **done** | Today landing, merged records with per-source attribution. |
| M6 Visual + a11y pass | **mostly done** | Six AA-checked palettes, dialog focus handling, keyboard-reachable feed/nav, reduced-motion. **Not done:** Photo Tour cinema view on a narrow screen. |

**Deviations from the plan**
- Apple mode has no dedicated *Trends* page; trends live on Summary. Strava mode folds *Activities* into *Feed* and shows awards as a trophy case inside *Profile*.
- Rings are real data only. With no Apple data the rings card invites the user to add it; nothing is estimated.
- The Strava `.gpx.gz` fix was not the real problem: the real export uses `.fit.gz`. FIT decoding is what unlocked routes.
- Place names on the Map no longer geocode by default (privacy); they are coordinates until the user opts in.
- Mode and theme are saved preferences; the default is hybrid + light regardless of OS settings.

**Next:** verify the Photo Tour and video export with real photos and on a phone; test on a physical iPhone; then Phase 2 (below). Weather and street data were ruled out.

---

## 1. Executive summary

- **What it is:** a 100% client-side, no-build vanilla JS app (Leaflet + D3 + JSZip, ~12k lines) that ingests Strava and Apple Health **export ZIPs** and shows a route heatmap, ~30 stats, charts, and a photo tour exportable as WebM.
- **Strength:** privacy-by-architecture (no backend, no tokens, no secrets in repo), two WCAG-checked themes, colorblind-safe palette, solid mobile layout, and a genuinely differentiated Photo Tour + video export.
- **Weakness:** it is a *dashboard*, not a *product*: no activity feed, no per-activity pace/splits, no rings, no awards, no persistence (re-parse every visit), no tests, no CI, no CSP/SRI.
- **Data is thrown away at the door:** parsers keep ~14 fields; calories, cadence, power, weather, moving time, sub-types (yoga, rowing…), Apple Activity Summary (rings) are discarded, which caps what Phase 1 can show.
- **Direction (decided):** three dataset-driven experiences: Apple mode, Strava mode, and a hybrid, each in light and dark.
- **Architecture is at its ceiling:** `app.js` (1,833 lines, global state, full re-render on every change) and `index.html` (2,837 lines incl. all CSS) need splitting before feature volume grows.

## 2. Phase 0 findings

### 2.1 Stack and structure
Vanilla HTML/CSS/ES modules; no `package.json`, bundler, linter, types or tests. Deployed via GitHub Pages branch setting from `master` (no `.github/`, no CI gate). Folders: `parsers/`, `map/`, `charts/`, `photos/`, `design-system/`, `scripts/`.

**Dependencies (all CDN, none vendored):** Leaflet 1.9.4 (unpkg, no SRI), JSZip 3.10.1 (cdnjs, no SRI), D3 `@7` (**floating major**), exifr 7.1.3 (upstream unmaintained), libheif-js 1.17.1 (behind), webm-muxer 5.0.3 (deprecated upstream in favor of mediabunny), Google Fonts. Unused: `coi-serviceworker.js` (retired stub, still loaded).

### 2.2 Data ingestion
- **Both sources are file-export only.** No OAuth, no Strava API, no HealthKit bridge, therefore **no rate limits or token refresh to manage** (a deliberate advantage; see Phase 2 for the cost).
- **Strava:** `activities.csv` hand-parsed + lazy GPX from ZIP. Dates correctly handled as UTC.
- **Apple:** streams `export.xml` via JSZip `internalStream` (875MB in ~4s, good); regex attribute extraction; routes attach only via `<FileReference>` (correct, documented).
- **Dedup:** `flagDuplicates` (app.js:275) O(n²), cross-source only, same type, start within 10 min, distance within 10%. It **flags but never merges**, so totals double-count unless filtered. Docblock stale (says 5 min/5%).
- **Storage:** none beyond UI prefs in localStorage. Every visit re-parses.

### 2.3 Map layer
Leaflet 1.9.4, **SVG renderer** (one `<path>` per route), Esri light-gray z0-16 + OSM z17-20, dark mode via CSS tile inversion. Heatmap caps at 10,000 routes, no simplification/decimation, per-path hover handlers; `allLatLngs.push(...big)` and `Math.min(...paces)` risk stack overflow on large routes; HR-colored single route creates one polyline per point pair (~10k paths for a long ride). Fine at 70 routes; **unproven at 1,000+**.

### 2.4 Feature status
| Feature | Status |
|---|---|
| Upload (Strava/Apple ZIP, GPX) | Works; photo-only upload broken (see blockers) |
| Heatmap (type / frequency), route hover/select | Works |
| Tools strip: Locations / By Month / Timelapse | Works; Locations sends coords to Nominatim |
| Stats (~30), distance, weekly calendar, records, HR zones | Works; mislabels and overlaps (below) |
| Activity detail (route by pace/HR, elevation+HR) | Works; no pace chart, no map↔chart linking |
| Photo Tour + cinema + export | Implemented; **not tested on real photos, not audited on narrow viewport**; "MP4" is a renamed WebM; no WebCodecs fallback |
| Plain `.xml` Apple import | **Broken** |
| Strava `.gpx.gz` / FIT / TCX routes | **Broken/unsupported** |

### 2.5 UI/UX state
Clean, consistent, mobile-safe; reads as a dashboard. Fonts Barlow Condensed + Inter; generic blue accent. Empty/loading/error: errors are 3-second toasts only; no on-map loading; charts don't redraw on window resize. **Accessibility gaps:** modals lack `role=dialog`/focus trap/Esc (upload, detail, lightbox, share); activity and photo list rows are clickable `<div>`s; tabs lack `aria-selected`/arrow keys; charts have no text alternative; filter labels lack `for`; no `prefers-reduced-motion`; tour has no keyboard controls.

### 2.6 Code quality and security
No tests, types or CI. Duplication: `haversine` ×4, `escapeHtml` ×4 (one doesn't escape `'`), tile URLs ×2, tooltip helper ×2, streak logic ×2, filter logic ×2 (`getFilteredActivities`/`getFilteredBaseActivities`). Tooltip `<div>`s leak per render. Unescaped `a.type`/`source` in innerHTML (safe only while mapped to a fixed set). **No CSP, no SRI**; a compromised CDN script has full access to health data and photos. No secrets in repo; `.gitignore` correctly excludes exports. **README privacy claim is incomplete** — Google Fonts, unpkg, cdnjs and Nominatim are also contacted.

Correctness bugs found: Strava `duration_s` uses *Elapsed* time but UI labels it "moving"; UTC timestamps read with local `getHours()` in stats; HR zones hard-code maxHR=200 and mix per-sample and per-activity counts; Strava ID falls back to `Math.random()`; Strava `TYPE_MAP` uses CamelCase keys, spaced CSV names ("Virtual Ride") likely fall to `Other` *(unverified)*; photo re-upload duplicates photos.

### 2.7 Blockers (fix before Phase 1)
1. **Persistence:** no IndexedDB cache; every Phase 1 screen needs fast reload and richer stored data.
2. **Data model too thin:** add moving time, calories, cadence, power, weather, sub-type, per-point streams; Apple Activity Summary (rings) and workout statistics. Without this Phase 1 cannot be built.
3. **`app.js` monolith + full re-render:** split into state/filters/format/views; introduce a small store with targeted updates; debounce search.
4. **Verified parser bugs:** `extractWorkoutStrings` undefined (apple.js:283); `.gpx.gz` never decompressed (strava.js:225-227); Strava type-name mapping; moving-time; photo-only upload early return (app.js:179, flagged by audit *(unverified)* since the guard is on `sourcesToParse`).
5. **Dedup must merge, not flag**, so totals and the feed are truthful; keep both source records, choose a primary.
6. **Map scalability:** canvas renderer (`preferCanvas`) + decimation + a spatial index before feed/segments/coverage work.
7. **Security baseline:** vendor or pin+SRI all scripts, add CSP, pin D3, fix privacy copy, consent for Nominatim.
8. **Test harness + CI:** parser regression tests (Node, sample fixtures, no real data committed) and a Playwright smoke test; a Pages deploy workflow.

### 2.8 Nice-to-haves
Single `haversine`/`escapeHtml`/tile-config modules; delete dead code (`estimateExportDuration`, `easeOutCubic`, `coi-serviceworker.js`); ResizeObserver for charts; fix stale dedup docblock and README duplication; Web Worker for parsing; replace exifr/webm-muxer; WebCodecs feature detection; OSM tile-policy fallback.

## 3. Phase 1 — Strava + Apple Fitness feel

### 3.1 Reference patterns (from memory; please verify against the real apps)
**Strava:** orange-accented, dense, white-card **feed** of activities (title, stat trio distance/pace/time, mini route map, kudos); **activity detail** with hero map, stats row, **splits table** (per km/mi, with bar-length pace), stacked synced **elevation/pace/HR charts** with scrub-to-map, **best efforts**, segments with ranks; **personal heatmap**; **profile** with weekly/yearly bar summaries, year selector, totals; "You" tab with training log and streaks.
**Apple Fitness:** black canvas, big rounded numerals, **three concentric Activity Rings** (Move red/pink, Exercise green, Stand blue/cyan) with day/week/month views, **Trends** (90-day vs 365-day arrows), **Awards** (shaped badges with dates, monthly challenges), workout summary cards with large metric tiles, route map with colored-by-pace line, **smooth spring motion** and generous spacing.
**Merge strategy (decided with you): three experience modes, chosen by which datasets are loaded.** One codebase, one normalized data model, one set of shared components (map, charts, photo tour); each mode is a different *shell* (navigation, landing view, theme tokens, density, motion) over those components. Original icons, an original rounded display face (e.g., Nunito/Figtree class, self-hosted), original badge art; no logos or proprietary artwork.

### 3.1b Experience modes
| | **Apple mode** (Apple Health only) | **Strava mode** (Strava only) | **Hybrid** (both) |
|---|---|---|---|
| Feel | Apple Fitness: black/near-black canvas in dark, soft light in light; big rounded numerals; ring colors; spring motion; generous space | Strava: dense white cards (dark equivalent), orange-leaning accent, condensed display type, data-first | Strava-style activity core with an Apple-style "Today" landing; one coherent accent system |
| Landing | **Summary**: rings (day/week/month), Trends, recent workouts, Awards | **Feed**: activity cards with mini-maps, weekly summary sidebar | **Today**: rings + trends + latest feed items |
| Nav | Summary · Workouts · Trends · Awards · Map · Photos | Feed · Activities · Map · Profile/Stats · Photos | Today · Feed · Map · Awards · Stats · Photos |
| Detail | Workout summary tiles (big metrics, HR range, route colored by pace) | Full Strava-style detail: splits, synced elevation/pace/HR charts, best efforts | Strava-style detail + Apple summary tiles; merged record shows both sources |
| Rings | Real (from `ActivitySummary`) | Not shown by default; optional "estimated Move-style goal" off by default | Real where Apple data exists |
| Awards | Apple-style badges and monthly challenges | Strava-style PRs, best efforts, streaks, year totals | Union, grouped by category |
| Heatmap | Present, Apple tokens | Present, prominent (Strava personal heatmap) | Present |

**Rules:** mode is auto-selected from loaded sources and can be manually overridden in a switcher (so a hybrid user can still view the pure Apple or pure Strava look). Mode drives *presentation and available modules*, never data parsing. Mode + theme (light/dark) are independent, giving 3 × 2 = 6 designed variants; each must pass WCAG AA (the existing theme work is the base). Hybrid picks the best-available field per metric (Apple HR/calories, Strava name/gear/weather) after dedup-merge.

### 3.2 Gap table
| Feature | Reference | Today | Gap | Approach | Effort | Depends on |
|---|---|---|---|---|---|---|
| Persistence | n/a | none | re-parse each visit | IndexedDB store of normalized activities + lazily cached streams | M | — |
| Richer model | n/a | 14 fields | calories, cadence, power, weather, moving time, sub-type | extend parsers + normalized model v2 + migration | M | persistence |
| Unified dedup | n/a | flag only | merge | merge to primary with field-level source priority | M | model v2 |
| Activity feed | Strava | list in Stats panel | cards, mini-maps, infinite scroll | new Feed view; static SVG mini-route thumbnails from decimated points | M | persistence, decimation |
| Activity detail | Strava | modal w/ route + elev/HR | splits, pace chart, scrub-sync, best efforts | full page/route (hash routing); splits from stream; synced D3 charts | L | stream model |
| Segments | Strava | none | none possible without server data | **Defer**: "auto-segments" = repeated route sections found locally (Phase 2) | — | — |
| Heatmap | Strava | have, both styles | filters by type/year, share image | mostly polish; year/type filters, export PNG | S | — |
| Weekly/yearly stats + profile | Strava | stats panel, 18-mo chart | year selector, weekly/yearly bars, totals, gear-less profile | Profile view; year-over-year charts | M | model v2 |
| Activity Rings | Apple | none | rings, day/week/month | parse `ActivitySummary`; SVG ring component; fall back to computed "estimated" rings for Strava-only users with explicit label | M | model v2 (Apple summary) |
| Trends | Apple | none | 90d vs 365d metrics | compute rolling windows; arrow cards | S | model v2 |
| Awards/badges | Apple | records only | badge system | rule engine (streaks, distance milestones, PRs, monthly challenge), original SVG badges, earned-date | M | model v2 |
| Workout summary tiles | Apple | partial | large-number tiles | restyle detail header | S | design |
| Visual language | both | dashboard | typography, motion, density | new tokens (rounded display font, motion/spring tokens, reduced-motion), ring/accent palette | M | — |
| Mode framework | both | one shell | three shells (Apple / Strava / Hybrid), auto-select + override, per-mode nav and landing | mode registry: nav config, landing view, token set, module visibility; shared components | M | split of app.js, token system |

### 3.3 Milestones (in order)
**M0 — Foundation (L).** Tasks: fix verified parser bugs; add Node parser tests + Playwright smoke (fixtures synthetic); split `app.js`; shared util modules; store + debounce; vendor/pin libs + SRI + CSP; Pages workflow; fix privacy copy; Nominatim consent. *Accept:* tests green in CI; real exports parse (Strava `.gz` routes load; plain `.xml` works); no CDN script without SRI/pin; Lighthouse a11y ≥ 90 on Map and Stats; behavior unchanged visually.
**M1 — Data layer (M).** IndexedDB persistence, model v2, dedup merge, canvas heatmap + decimation. *Accept:* reload shows data in <1s without re-upload; "Clear data" control; totals no longer double-count; 1,000-route synthetic heatmap pans at ≥ 30fps; "Delete all data" works.
**M2 — Mode framework + shared components (M).** Hash routing; mode registry (nav, landing, token set, module visibility); source detection and manual override switcher; per-mode token sets × 2 themes scaffolded; shared components extracted (stat tile, ring, chart card, route map, splits table). *Accept:* loading Apple-only, Strava-only, and both each land in the right mode; switcher persists; no mode-specific logic inside parsers or shared components.
**M3 — Strava mode (L).** Feed with mini-map cards, full activity detail (splits, pace/HR/elevation synced charts with scrub-to-map, best efforts), profile with weekly/yearly stats and year selector, Strava-style PRs/streaks. *Accept:* every routed activity opens `#/activity/<id>`; chart scrub moves a map marker; splits sum to distance within 1%; yearly totals reconcile with the feed.
**M4 — Apple mode (M–L).** Summary landing with rings (day/week/month), Trends (90d vs 365d), Awards + monthly challenge, workout summary tiles, Apple-style motion with reduced-motion fallback. *Accept:* ring values match Apple's `ActivitySummary` for a known day; awards earned-dates reproducible; animations disabled under `prefers-reduced-motion`.
**M5 — Hybrid mode (M).** Today landing combining rings/trends with feed; detail view with both tile sets; unified awards; per-metric source priority visible in the UI ("HR from Apple Watch"). *Accept:* a duplicated workout appears once, with both sources listed; no metric shown twice; switching to pure Apple or Strava views from hybrid data works.
**M6 — Visual and accessibility pass (M).** Finalize all 6 variants (3 modes × 2 themes), fonts, motion tokens, dialog/focus/keyboard a11y, narrow-viewport audit of Photo Tour. *Accept:* all six variants AA; keyboard-only run through every view; no horizontal overflow at 375px.
Order rationale: M3 before M4 because the detail/stream work is the larger dependency on model v2; M4 and M3 can run in parallel if capacity allows; M5 last since it composes both.

## 4. Phase 2 — Our own spin

| Idea | Impact | Effort | New data / backend? | Rank |
|---|---|---|---|---|
| Photo story-map replay (extend existing Photo Tour: shareable offline "story" HTML/video, chapters, captions, auto-title) | High (unique, already half built) | M | No | 1 |
| Local-first/privacy as product (offline PWA, "nothing leaves device" proof panel, encrypted export/import of the IndexedDB) | High (identity) | M | No | 2 |
| Coverage exploration ("streets I've never run"): tile/street coverage %, unexplored suggestions, "new this month" | High | L | OSM street data (Overpass/PMTiles; vendored bundle or optional fetch) | 3 |
| Cross-source analytics: HR+route+weather+photos, "what conditions do I run best in" | Med-High | M–L | **Weather needs an API** (Open-Meteo; coordinates leave device) or Strava CSV weather columns | 4 |
| Auto-segments: detect repeated route sections locally and rank your own efforts | Med | L | No | 5 |
| Year-in-review shareable card (the existing share-card gap) | Med | S–M | No | 6 |

Phase 2 features are mode-aware: each ships in all three modes where it makes sense (e.g., coverage and story replay in all; cross-source analytics hybrid-only by nature).
Milestones: M7 Story replay (accept: export a story from 1 workout with ≥5 photos on desktop and iPhone), M8 PWA/offline + encrypted backup, M9 coverage (accept: coverage % computed for a city in <10s, tiles bundled), M10 cross-source analytics with an explicit opt-in for any network call.

**Considered and rejected:** live Strava OAuth sync (needs backend for secret, rate limits, breaks privacy story — revisit only as optional later); social features/kudos/following (needs backend, off-strategy); Garmin (deliberately unsupported, no test data); native HealthKit bridge (needs an iOS app); full segment leaderboards (no data); AI coaching text (privacy and low value); Apple-copy icons/badges/fonts (legal).

## 5. Risks and open questions
**Risks:** real Strava CSV type names and `.gz` behavior unverified; Safari memory on large Apple ZIPs untested on device; OSM/Esri tile policies for sustained use; WebCodecs availability/real photo pipeline untested; IndexedDB quota for streams; "mimic" boundaries (trade-dress) — keep original assets; GitHub Pages cache (10 min) complicates verification.
**Open questions for you:**
1. Is the live URL/site public with real users, or just yours (affects CSP/SRI urgency and migration care)?
2. Hard line on privacy: is *any* optional network call (weather, street data) acceptable if opt-in?
3. Is adding a build step/`package.json` (for tests and vendoring) acceptable, or must it stay no-build?
4. Mode switching: auto-select only, or always show a manual switcher? Should a hybrid user be able to pick pure Apple/Strava looks?
5. In hybrid, when Strava and Apple disagree on a metric (distance, HR), which source wins by default?
6. Strava-only users: any "estimated rings" at all, or purely none?
7. Target devices: desktop-first or phone-first (affects Feed density and Photo Tour priority)?
8. Branding: keep "Bold Sports" shared design system with sibling apps, or diverge (the three modes require new token sets either way)?
9. May the repo-name mismatch (`exercise-visualizer` URL vs `fitness-visualizer`) be fixed?
(Resolved: build both Strava-like detail and Apple rings, as separate modes plus hybrid.)
