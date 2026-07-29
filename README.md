# Fitness Visualizer

A **100% client-side** fitness data visualizer. Drop in your Strava, Apple Health, or Garmin export and see a heatmap of every route you've ever recorded, per-activity charts, and a photo tour that pairs your camera roll with the workout that was happening when each shot was taken.

Your files never leave the browser. There is no server, no account, no cloud storage.

**Live app:** https://colemccall.github.io/exercise-visualizer/

---

## Features

### Navigation

A persistent top bar with **Map / Charts / Photos** tabs — three sibling views instead of one long scroll. Upload is a modal (auto-opens on first visit, reachable anytime via "Upload data"). Two complete themes — light and dark are each independently designed and WCAG AA checked, not a token flip on top of one palette — with the activity-type colors (Run/Ride/Walk/Hike/Swim) using the colorblind-safe Okabe-Ito palette so every type stays distinguishable under the common forms of color blindness. See [design-system/fitness-theme.md](design-system/fitness-theme.md) for the full token reference.

### Map view

- **Heatmap** of every GPS route with two styles:
  - *By type* — coloured per activity
  - *Frequency* — every route drawn in one low-opacity colour so repeat paths visually darken
- Locations / By Month / Timelapse controls below the map

### Charts view

- Filter by type, date range, month, or free text
- Deduplication flags the same activity recorded by multiple devices
- Metric / imperial toggle (persisted, defaults to miles)
- Monthly distance stacked by activity type, weekly activity calendar, HR zones, personal records, per-activity elevation profile + heart-rate line

### Photos view — Photo Tour

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
- Real CartoDB Positron basemap tiles drawn under the route; moving dot sits exactly on a solid tour polyline (no drift between dot and trace)
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
index.html          — app shell, top nav, view routing markup, upload modal, all CSS
app.js              — state, upload orchestration, dedup, view routing (Map/Charts/Photos)
design-system/
  theme.css         — shared design system (used by sibling apps — see its own README)
  activity-colors.js— single source of truth for activity-type colors (Okabe-Ito palette)
  fitness-theme.md  — this app's two-theme token reference
parsers/
  strava.js         — CSV + GPX (from ZIP)
  apple.js          — chunked export.xml + workout-routes/*.gpx
  gpx.js            — shared GPX trackpoint parser (returns time, ele, hr)
  photos.js         — EXIF via exifr (photos + video atoms)
map/
  heatmap.js        — multi-route Leaflet layer
  route.js          — single-activity route, coloured by pace or HR
charts/             — D3 v7 charts (distance, weekly, hr-zones, elevation, records)
photos/
  matcher.js        — pair photos to workouts, interpolate GPS from GPX time
  list.js           — workouts-with-photos list
  detail.js         — route + photo grid + cinema tour + share modal
  heic.js           — lazy libheif-js decoder
  video.js          — first-frame poster capture via <video> + canvas
  composite.js      — per-frame drawing (basemap tiles + route + dot + media + intro title card)
  export.js         — video render pipeline (timeline, WebCodecs VideoEncoder, GPS spike filter)
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
- ESM script downloads from `jsdelivr.net` (D3, exifr, libheif-js) — happens once per page load and is cacheable

If you want fully offline operation, vendor the CDNs locally.

---

## Tech

Vanilla HTML / CSS / JS. Leaflet (maps), D3 v7 (charts), JSZip (ZIP parsing), exifr (EXIF), libheif-js (HEIC decode). No framework, no bundler, no build step.
