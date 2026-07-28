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
- **Cinema tour mode** — press Play to enter a full-screen tour. The dot traces the entire route in three-phase transits (zoom-out to preview the route slice, animate the dot at a constant km/s, zoom in on the next photo). Split screen shows the active photo/video during each hold; the map full-screens during transits. Videos autoplay with sound (falls back to muted + tap-to-unmute if the browser blocks it).
- HEIC images and MP4/MOV videos are supported (HEIC is decoded via lazy-loaded `libheif-js`; MP4/MOV timestamps come from QuickTime atoms via exifr).

### Share as video

Every workout's Photo Tour has a **Share** button that renders the animation to a **WebM file** so you can post it. Plays inline in Twitter/X, iMessage, Discord, WhatsApp, and Slack. All rendering happens client-side via `canvas.captureStream` + `MediaRecorder` — no server, no wasm.

- **Camera style**: *Overview* (whole route always visible) or *Follow the route* (camera tracks the dot at a tighter zoom)
- **Cinematic intro** (optional, default on): first few seconds start at a state/country-scale view with a "City, State" text overlay (reverse-geocoded via OpenStreetMap Nominatim), then zoom in to the route
- **Trip name** field — puts your own label in the video header
- **Live estimated length** — the "≈ Ns" label updates as you tweak sliders
- Sliders for **animation speed** (dot moves at a constant km/s regardless of GPX density), **photo pause**, and **max video play time**
- Real CartoDB Positron basemap tiles drawn under the route; moving red dot sits exactly on a solid tour polyline (no drift between dot and trace)

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
  detail.js         — route + photo grid + cinema tour + share modal
  heic.js           — lazy libheif-js decoder
  video.js          — first-frame poster capture via <video> + canvas
  composite.js      — per-frame drawing (basemap tiles + route + dot + media + intro text)
  export.js         — WebM render pipeline (timeline, MediaRecorder, Nominatim geocode)
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

- Leaflet tile requests to `arcgisonline.com` (dashboard heatmap basemap)
- CartoDB tile requests to `basemaps.cartocdn.com` (video export basemap)
- One Nominatim reverse-geocode call to `nominatim.openstreetmap.org` per video export when the cinematic intro is enabled — sends the route's center lat/lng (not any personal data) and receives back a city/state label
- ESM script downloads from `jsdelivr.net` (D3, exifr, libheif-js) — happens once per page load and is cacheable

If you want fully offline operation, vendor the CDNs locally and turn off the cinematic intro when exporting.

---

## Tech

Vanilla HTML / CSS / JS. Leaflet (maps), D3 v7 (charts), JSZip (ZIP parsing), exifr (EXIF), libheif-js (HEIC decode). No framework, no bundler, no build step.
