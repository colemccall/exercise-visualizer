# Fitness Visualizer — Claude Code Context

Client-side fitness data visualizer. Upload Strava, Apple Health, or Garmin export ZIPs. All parsing happens in the browser — no data ever leaves the device. Shows activity heatmap, charts, and activity detail with route map.

## Current State

**Built and working:**
- Upload screen: 3 drop zones (Strava, Apple, Garmin), drag-or-click, progress bar
- Privacy notice (prominent, required)
- All 4 parsers: strava.js, apple.js, garmin.js, gpx.js
- Normalized Activity data model (all sources produce identical objects)
- Deduplication: flags activities within 5 min + 5% distance as possible duplicates
- Dashboard: stats bar, activity list, filter by type + date range
- Heatmap: Leaflet multi-route layer, lazy-loads top 50 routes on first render
- Activity detail modal: single route map, elevation profile, HR chart
- 4 D3 charts: distance over time, weekly stacked bar, HR zones, elevation profile
- Metric/imperial toggle (localStorage)
- Source badges per activity

**Not yet built:**
- [ ] End-to-end test with real Strava/Apple/Garmin ZIP files — parsers written but untested against real exports
- [ ] Loading progress bar during large XML parse (Apple Health can be 500MB+)
- [ ] Mobile responsive layout
- [ ] Share card (html2canvas summary PNG) — not in original spec but worth adding
- [ ] Railway / GitHub Pages deployment

No auth needed — fully anonymous. No data stored between sessions.

## Design System

Uses `../../design-system/theme.css` (or `./design-system/theme.css` after repo split).
App theme class: `.app-fitness` (red `#DC2626` → orange `#EA580C`).
Fonts: Barlow Condensed (headlines) + Inter (body) via Google Fonts.

## Tech Stack

Vanilla HTML/CSS/JS. Leaflet + D3 v7 (ESM) + JSZip via CDN.
**Requires a local server** — ES module imports won't work from `file://`.
Use VS Code Live Server extension or: `npx serve .`

## Key Files

```
index.html              — app shell, upload screen, dashboard layout
app.js                  — state, upload handling, dedup, unit toggle, activity list
parsers/
  gpx.js               — shared GPX parser (DOMParser-based)
  strava.js            — Strava ZIP: activities.csv + GPX lazy load
  apple.js             — Apple Health: chunked export.xml parsing
  garmin.js            — Garmin: summarizedActivities.json + GPX
charts/
  distance.js          — D3 line chart (distance over time + 30-day MA)
  weekly.js            — D3 stacked bar (activities per week by type)
  hr-zones.js          — D3 horizontal bar (% time in 5 HR zones)
  elevation.js         — D3 area chart (elevation profile, detail view)
map/
  heatmap.js           — multi-route Leaflet Polyline layer
  route.js             — single activity route, color-coded by pace
```

## Normalized Activity Model

Every parser returns this — the UI never reads raw source data:
```javascript
{
  id: String,                    // "strava-12345678"
  source: "strava"|"apple"|"garmin",
  name: String,
  type: "Run"|"Ride"|"Walk"|"Hike"|"Swim"|"Other",
  date: Date,
  distance_m: Number,            // always meters internally
  duration_s: Number,            // always seconds
  elevation_gain_m: Number|null,
  avg_heart_rate: Number|null,
  max_heart_rate: Number|null,
  has_route: Boolean,
  gpx_file: String|null,         // ZIP-internal path for lazy load
  route_points: null,            // populated on demand by loadRoute()
  has_duplicate: false,          // set by dedup logic in app.js
}
```

## Testing the Parsers

To test without real ZIP files, create a mock:
```javascript
// In browser console after opening index.html via Live Server:
// Drag a real Strava export.zip onto the Strava drop zone
// Check console for parse errors and activity count
```

Real export sources:
- **Strava**: strava.com/athlete/delete_your_account → Request Archive
- **Apple**: iPhone Settings → Health → your profile → Export All Health Data
- **Garmin**: garmin.com/account/dataManagement → Export Data

## Apple Health Performance Note

`apple.js` uses chunked regex parsing to avoid loading 500MB+ XML into DOM.
If users report browser freezes on very large files, the next step is moving
`apple.js` parsing into a Web Worker. The function signature stays the same —
just wrap in `new Worker()` and use `postMessage` for the zip file and results.

## Activity Type Colors (consistent across all charts + map)

```javascript
const TYPE_COLORS = {
  Run:   '#FF6B6B',  // coral
  Ride:  '#4A90D9',  // blue
  Walk:  '#5CB85C',  // green
  Hike:  '#F0AD4E',  // amber
  Swim:  '#5BC0DE',  // teal
  Other: '#aaaaaa',  // grey
};
```

## Real Test Data

Real export ZIPs are already available at `c:\Projects\VibeCoding\Workout-Maps\`:
- `export-2.zip` (~58MB) — drag onto Strava or Apple drop zone to test
- `export-3.zip` (~58.4MB)
- `export_105992264.zip` (~11.9MB) — likely Garmin export
- `Mix of Apple Watch and Strava GPX\` — individual GPX files for quick parser testing

Start here for step 1 of remaining work — no need to request an archive export.

---

## Remaining Work (Ordered)

1. **Test with real data** — use the ZIPs in `Workout-Maps\` above. Run through the full parse flow. Fix any parser bugs found.
2. Loading progress bar: show % complete during Apple XML chunked parse
3. Large file handling: test Apple export >100MB, add Web Worker if needed
4. Mobile responsive: activity list full-width, charts stack vertically
5. Deploy to Railway or GitHub Pages
