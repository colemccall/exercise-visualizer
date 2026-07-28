# Fitness Visualizer

A **100% client-side** fitness data visualizer. Drop in your Strava, Apple Health, or Garmin export and see a heatmap of every route you've ever recorded, per-activity charts, and a photo tour that pairs your camera roll with the workout that was happening when each shot was taken.

Your files never leave the browser. There is no server, no account, no cloud storage.

**Live app:** https://colemccall.github.io/exercise-visualizer/

---

## Features

### Activity dashboard
- **Heatmap** of every GPS route with two styles:
  - *By type* — coloured per activity (Run / Ride / Walk / Hike / Swim)
  - *Frequency* — every route drawn in one low-opacity colour so repeat paths visually darken
- Filter by type, date range, month, or free text
- Deduplication flags the same activity recorded by multiple devices
- Metric / imperial toggle (persisted)
- Dark mode

### Photo Tour
- Drop in photos and/or videos alongside your workouts
- Each media item is matched to the workout that was underway when it was taken (EXIF timestamp → workout start/end window, adjustable ±0–30 min)
- If the photo has EXIF GPS it's plotted directly; otherwise the position is interpolated from the workout's GPX trackpoints
- Per-workout detail view shows the route, small photo markers on the map, and a full grid of every attached photo — click any tile to open a lightbox and fly the map to that spot
- **Tour mode** (Play/Prev/Next) auto-advances through photos in chronological order
- HEIC images and MP4/MOV videos are supported (HEIC is decoded via lazy-loaded `libheif-js`; video markers show a first-frame poster with a play badge)

### Charts
- Monthly distance stacked by activity type
- Weekly activity calendar
- HR zones (when data is present)
- Personal records
- Per-activity elevation profile + heart-rate line

---

## Getting your data

| Source | How to export |
|---|---|
| **Strava** | strava.com → Settings → My Account → Download or Delete Your Account → Request Your Archive |
| **Apple Health** | iPhone Health app → profile picture → Export All Health Data |
| **Garmin** | garmin.com → account → Data Management → Export Data |

Drop the resulting ZIP on the matching upload zone. Photos are dragged in loose (JPG / HEIC / MP4 / MOV).

---

## Running locally

The app is static — no build step. But ES modules require a real server (not `file://`).

```bash
npx serve .
# → http://localhost:3000
```

Or use the VS Code **Live Server** extension.

> On Windows, avoid `python -m http.server` — it serves `.js` files as `text/plain`, which breaks module loading in strict-MIME browsers.

---

## Optional: pre-extract photo EXIF (large libraries)

For huge photo collections, browser-side EXIF parsing can be slow. There's an optional Python script that pre-extracts timestamps + GPS and copies photos into `photos/`:

```bash
pip install exifread Pillow
python scripts/prepare_photos.py <your-photo-folder>
```

Next page load, `data/photos.json` is picked up automatically. Matching still runs in the browser.

---

## Architecture

```
index.html          — app shell, all screens, all CSS
app.js              — state, upload orchestration, dedup, view routing
parsers/
  strava.js         — CSV + GPX (from ZIP)
  apple.js          — chunked export.xml + workout-routes/*.gpx
  gpx.js            — shared GPX trackpoint parser (returns time, ele, hr)
  photos.js         — EXIF via exifr (photos + video atoms)
map/
  heatmap.js        — multi-route Leaflet layer
  route.js          — single-activity route, coloured by pace or HR
charts/             — D3 v7 charts
photos/
  matcher.js        — pair photos to workouts, interpolate GPS from GPX time
  list.js           — workouts-with-photos list
  detail.js         — route + photo grid + tour + lightbox
  heic.js           — lazy libheif-js decoder
  video.js          — first-frame poster capture via <video> + canvas
scripts/
  prepare_photos.py — optional offline EXIF extractor
```

### Normalized activity model

Every parser produces the same shape so the UI never touches raw source data:

```javascript
{
  id, source, name, type,
  date: Date,
  distance_m, duration_s, elevation_gain_m,
  avg_heart_rate, max_heart_rate,
  has_route, gpx_file, route_points,
  _gpxLoader,             // lazy async function
  has_duplicate,
  photos: [{id, url, lat, lng, timestamp, interpolated, isHEIC, isVideo}]
}
```

---

## Privacy

Everything runs in the browser. No fitness data, no photo bytes, and no metadata are sent to any server. The only external HTTP requests are:

- Leaflet tile requests to `arcgisonline.com` (for the basemap)
- ESM script downloads from `jsdelivr.net` (D3, exifr, libheif-js) — happens once per page load and is cacheable

If you want fully offline operation, vendor those two CDNs locally.

---

## Tech

Vanilla HTML / CSS / JS. Leaflet (maps), D3 v7 (charts), JSZip (ZIP parsing), exifr (EXIF), libheif-js (HEIC decode). No framework, no bundler, no build step.
