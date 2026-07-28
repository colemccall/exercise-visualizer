/**
 * photos/detail.js
 * Photos Explorer detail view — renders one workout's route with photo
 * markers plotted along it, plus a full grid of all photos below the map
 * and a Play/Prev/Next tour that flies the map between them.
 */

import { renderRoute } from '../map/route.js';
import { ensurePhotoURL } from './heic.js';
import { ensureVideoPoster } from './video.js';
import { exportTourVideo, downloadBlob } from './export.js';

let _mapRef = null;
let _tourIdx = 0; // index into entries for the current photo (for tile highlight)
let _tour = null;
/**
 * _tour when running: {
 *   container, entries, route, segments, totalMs,
 *   startedAt, pausedAtElapsed,   // elapsed ms captured on pause
 *   rafId, running,
 *   dotMarker,                    // L.circleMarker following the route
 *   currentPhotoIdx,              // last photo shown in preview
 *   currentSegKind,               // 'transit' | 'hold' — for cinema layout
 * }
 */
// Cinema tour timing. Each transit is split into three phases so the map
// has time to zoom out, pan while animating the dot, then zoom in on the
// next photo. Total-transit is generous so the story feels cinematic.
const TRANSIT_TOTAL_MS = 30000;   // whole-route sum of transit time
const PHOTO_HOLD_MS    = 5000;    // per-photo hold (photo shown split-screen)
const VIDEO_HOLD_MS    = 10000;   // per-video hold, longer so playback finishes
const VIDEO_TAIL_MS    = 500;
const MIN_TRANSIT_MS   = 3200;    // ensures phase splits are visible even for close photos

/**
 * @param {HTMLElement} container
 * @param {Activity} activity  Must have activity.photos populated
 * @param {{onBack: () => void}} opts
 */
export async function renderPhotosDetail(container, activity, opts) {
  stopTour();

  container.innerHTML = `
    <div class="photos-detail-header">
      <button class="bs-btn-ghost" id="pd-back">&larr; Back</button>
      <div class="photos-detail-title">
        <div class="photos-detail-name">${escapeHtml(activity.name || activity.type)}</div>
        <div class="photos-detail-meta">${escapeHtml(activity.type)} · ${formatDate(activity.date)} · ${activity.photos.length} photo${activity.photos.length === 1 ? '' : 's'}</div>
      </div>
      <div class="photos-detail-tour">
        <button class="tl-btn" id="pd-prev" title="Previous">&larr;</button>
        <button class="tl-btn" id="pd-play" title="Play tour">&#9654; Play</button>
        <button class="tl-btn" id="pd-next" title="Next">&rarr;</button>
        <button class="tl-btn" id="pd-share" title="Export tour as video">&#128190; Share</button>
      </div>
    </div>

    <div class="photos-detail-mapwrap">
      <div id="pd-map" class="photos-detail-map"></div>
      <div id="pd-preview" class="pd-preview" hidden aria-hidden="true">
        <div class="pd-preview-media" id="pd-preview-media"></div>
        <div class="pd-preview-caption" id="pd-preview-caption"></div>
      </div>
    </div>
    <div class="cinema-controls" role="group" aria-label="Tour controls">
      <button class="tl-btn" id="pd-cinema-prev" title="Previous">&larr;</button>
      <button class="tl-btn" id="pd-cinema-pause" title="Pause tour">&#9646;&#9646;</button>
      <button class="tl-btn" id="pd-cinema-next" title="Next">&rarr;</button>
      <button class="tl-btn" id="pd-cinema-exit" title="Exit fullscreen">&times;</button>
    </div>

    <div class="photos-detail-legend">
      <span><span class="pd-legend-dot solid"></span> EXIF GPS</span>
      <span><span class="pd-legend-dot dashed"></span> Interpolated from GPX time</span>
      <span class="pd-legend-hint">Click any photo below to fly the map there and open it.</span>
    </div>

    <div id="pd-grid" class="pd-grid"></div>

    <div id="pd-lightbox" class="pd-lightbox" hidden>
      <div class="pd-lightbox-inner">
        <div id="pd-lightbox-media" class="pd-lightbox-media"></div>
        <div id="pd-lightbox-caption" class="pd-lightbox-caption"></div>
        <button class="pd-lightbox-close" id="pd-lightbox-close">&times;</button>
      </div>
    </div>

    <div id="pd-share-modal" class="pd-share-modal" hidden>
      <div class="pd-share-inner">
        <div class="pd-share-header">
          <div class="pd-share-title">Export tour as video</div>
          <button class="pd-share-close" id="pd-share-close">&times;</button>
        </div>
        <div class="pd-share-body">
          <p class="pd-share-hint">
            Animates the workout: dot traces the whole route, pausing at each photo. Renders a WebM that plays inline in Twitter/X, iMessage, Discord, WhatsApp, and Slack.
          </p>
          <div class="pd-share-row">
            <label>Trip name</label>
            <input type="text" id="pd-share-title" class="pd-share-input" maxlength="60" placeholder="e.g. Sunday long run" />
          </div>
          <div class="pd-share-row">
            <label>Camera style</label>
            <select id="pd-share-mode" class="pd-share-select">
              <option value="overview" selected>Overview — whole route always visible</option>
              <option value="follow">Follow the route — zoomed in, camera tracks the dot</option>
            </select>
          </div>
          <div class="pd-share-row">
            <label>Output format</label>
            <select id="pd-share-format" class="pd-share-select">
              <option value="webm" selected>WebM — fast (works in most players + social apps)</option>
              <option value="mp4">MP4 — slower first time (~25 MB one-time encoder download; needed for Instagram)</option>
            </select>
          </div>
          <div class="pd-share-row pd-share-check-row">
            <label class="pd-share-check">
              <input type="checkbox" id="pd-share-intro" checked />
              <span>Cinematic intro — start with a state/country view + location label</span>
            </label>
          </div>
          <div class="pd-share-row" id="pd-share-intro-row">
            <label>Intro length <span id="pd-share-introlen-val">3s</span></label>
            <input type="range" id="pd-share-introlen" min="2" max="5" step="1" value="3" />
          </div>
          <div class="pd-share-row">
            <label>Animation speed <span id="pd-share-speed-val">1.0×</span></label>
            <input type="range" id="pd-share-speed" min="0.5" max="3" step="0.1" value="1" />
          </div>
          <div class="pd-share-row">
            <label>Pause on photos <span id="pd-share-hold-val">3s</span></label>
            <input type="range" id="pd-share-hold" min="1" max="8" step="1" value="3" />
          </div>
          <div class="pd-share-status" id="pd-share-status" hidden>
            <div class="pd-share-progress"><div id="pd-share-progress-fill"></div></div>
            <div id="pd-share-status-label" class="pd-share-status-label"></div>
          </div>
        </div>
        <div class="pd-share-footer">
          <button class="bs-btn bs-btn-secondary" id="pd-share-cancel">Cancel</button>
          <button class="bs-btn" id="pd-share-go">Export</button>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#pd-back').addEventListener('click', () => {
    stopTour(container);
    opts.onBack();
  });

  // Ensure route is loaded before rendering.
  if (!activity.route_points && typeof activity._gpxLoader === 'function') {
    try { activity.route_points = await activity._gpxLoader(); } catch {}
  }

  const mapEl = container.querySelector('#pd-map');
  const map = renderRoute(activity, mapEl);
  _mapRef = map;

  // Build the entries once — each carries its playable URL, poster URL, and
  // (later) references to the DOM elements so we can highlight them.
  const entries = [];
  for (let i = 0; i < activity.photos.length; i++) {
    const p = activity.photos[i];
    if (p.lat === null || p.lng === null) continue;
    const src = p._source || p;
    const playableURL = p.isVideo ? src.url : await ensurePhotoURL(src);
    const thumbURL    = p.isVideo ? await ensureVideoPoster(src) : playableURL;
    entries.push({ photo: p, playableURL, thumbURL, marker: null, tile: null, isVideo: !!p.isVideo });
  }

  // Plot map markers (small circles). Skip if map failed to render.
  if (map) {
    entries.forEach((entry, i) => {
      const { photo, thumbURL } = entry;
      const marker = L.marker([photo.lat, photo.lng], {
        icon: L.divIcon({
          className: 'photo-marker-wrap',
          html: makeMarkerHTML(thumbURL, photo.interpolated, photo.isVideo),
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        }),
      });
      marker.on('click', () => activate(container, entries, i, { openLightbox: true, fly: true }));
      marker.addTo(map);
      entry.marker = marker;
    });
  }

  // Build the photo grid — always visible, always populated.
  const grid = container.querySelector('#pd-grid');
  if (entries.length === 0) {
    grid.innerHTML = `<div class="pd-grid-empty">No photos have a resolvable location for this workout.</div>`;
  } else {
    entries.forEach((entry, i) => {
      const { photo, thumbURL } = entry;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pd-tile';
      tile.innerHTML = `
        <div class="pd-tile-thumb" style="${thumbURL ? `background-image:url('${cssEscape(thumbURL)}')` : ''}">
          ${photo.isVideo ? '<span class="pd-tile-play">&#9654;</span>' : ''}
          ${photo.interpolated ? '<span class="pd-tile-badge" title="Interpolated position">≈</span>' : ''}
          ${!thumbURL && photo.isHEIC ? '<span class="pd-tile-fallback">HEIC</span>' : ''}
        </div>
        <div class="pd-tile-caption">${escapeHtml(photo.timestamp ? formatTime(photo.timestamp) : (photo.name || ''))}</div>
      `;
      tile.addEventListener('click', () => activate(container, entries, i, { openLightbox: true, fly: true }));
      grid.appendChild(tile);
      entry.tile = tile;
    });
  }

  // Tour controls (header + floating cinema-mode set)
  container.querySelector('#pd-prev').addEventListener('click', () => stepTour(container, entries, -1));
  container.querySelector('#pd-next').addEventListener('click', () => stepTour(container, entries, +1));
  container.querySelector('#pd-play').addEventListener('click', () => toggleTour(container, entries, activity));
  container.querySelector('#pd-cinema-prev')?.addEventListener('click', () => stepTour(container, entries, -1));
  container.querySelector('#pd-cinema-next')?.addEventListener('click', () => stepTour(container, entries, +1));
  container.querySelector('#pd-cinema-pause')?.addEventListener('click', () => toggleTour(container, entries, activity));
  container.querySelector('#pd-cinema-exit')?.addEventListener('click', () => stopTour(container));

  // Lightbox close (stop any playing video)
  const lb = container.querySelector('#pd-lightbox');
  const media = container.querySelector('#pd-lightbox-media');
  const closeLightbox = () => { lb.hidden = true; media.innerHTML = ''; };
  container.querySelector('#pd-lightbox-close').addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });

  // Share (export tour as video) modal
  wireShareModal(container, activity);
}

function wireShareModal(container, activity) {
  const modal = container.querySelector('#pd-share-modal');
  const openBtn  = container.querySelector('#pd-share');
  const closeBtn = container.querySelector('#pd-share-close');
  const cancelBtn = container.querySelector('#pd-share-cancel');
  const goBtn = container.querySelector('#pd-share-go');
  const titleIn = container.querySelector('#pd-share-title');
  const modeIn  = container.querySelector('#pd-share-mode');
  const formatIn = container.querySelector('#pd-share-format');
  const introIn = container.querySelector('#pd-share-intro');
  const introLenIn = container.querySelector('#pd-share-introlen');
  const introLenLbl = container.querySelector('#pd-share-introlen-val');
  const introRow = container.querySelector('#pd-share-intro-row');
  const speedIn = container.querySelector('#pd-share-speed');
  const holdIn  = container.querySelector('#pd-share-hold');
  const speedLbl = container.querySelector('#pd-share-speed-val');
  const holdLbl  = container.querySelector('#pd-share-hold-val');
  const statusEl = container.querySelector('#pd-share-status');
  const statusLbl = container.querySelector('#pd-share-status-label');
  const progFill  = container.querySelector('#pd-share-progress-fill');

  // Prefill trip name from the activity's title
  if (titleIn && activity.name) titleIn.value = activity.name;

  const syncIntroVisibility = () => {
    introRow.style.display = introIn.checked ? '' : 'none';
  };

  const close = () => {
    if (goBtn.disabled) return; // don't close mid-render
    modal.hidden = true;
    statusEl.hidden = true;
    statusLbl.textContent = '';
    progFill.style.width = '0%';
  };

  openBtn.addEventListener('click', () => { modal.hidden = false; syncIntroVisibility(); });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  speedIn.addEventListener('input', () => { speedLbl.textContent = `${(+speedIn.value).toFixed(1)}×`; });
  holdIn.addEventListener('input',  () => { holdLbl.textContent  = `${holdIn.value}s`; });
  introIn.addEventListener('change', syncIntroVisibility);
  introLenIn.addEventListener('input', () => { introLenLbl.textContent = `${introLenIn.value}s`; });

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    cancelBtn.disabled = true;
    closeBtn.disabled = true;
    statusEl.hidden = false;
    try {
      const blob = await exportTourVideo({
        activity,
        opts: {
          title: titleIn.value,
          mode: modeIn.value,
          format: formatIn.value,
          intro: introIn.checked,
          introSec: +introLenIn.value,
          animSpeed: +speedIn.value,
          photoPauseSec: +holdIn.value,
          onProgress: (pct, label) => {
            progFill.style.width = `${pct}%`;
            if (label) statusLbl.textContent = `${label} ${pct}%`;
          },
        },
      });
      const dateStr = activity.date ? activity.date.toISOString().slice(0, 10) : 'tour';
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(blob, `workout-tour-${dateStr}.${ext}`);
      statusLbl.textContent = 'Saved to Downloads';
    } catch (err) {
      console.error('[share] export failed', err);
      statusLbl.textContent = `Failed: ${err.message || err}`;
    } finally {
      goBtn.disabled = false;
      cancelBtn.disabled = false;
      closeBtn.disabled = false;
    }
  });
}

function activate(container, entries, idx, { openLightbox, fly }) {
  _tourIdx = idx;
  const { photo, playableURL, tile } = entries[idx];

  // Highlight the active tile (visible when not in cinema)
  entries.forEach(e => e.tile?.classList.remove('active'));
  tile?.classList.add('active');
  tile?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

  if (fly && _mapRef) {
    try { _mapRef.flyTo([photo.lat, photo.lng], 13, { duration: 1.0 }); } catch {}
  }
  if (openLightbox) showLightbox(container, photo, playableURL);
}

function showLightbox(container, photo, url) {
  const lb    = container.querySelector('#pd-lightbox');
  const media = container.querySelector('#pd-lightbox-media');
  const cap   = container.querySelector('#pd-lightbox-caption');
  media.innerHTML = '';
  if (photo.isVideo && url) {
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    v.className = 'pd-lightbox-video';
    media.appendChild(v);
  } else if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = photo.name || '';
    img.className = 'pd-lightbox-img';
    media.appendChild(img);
  } else {
    const p = document.createElement('div');
    p.className = 'pd-lightbox-fallback';
    p.textContent = 'HEIC decode failed — export as JPG to preview.';
    media.appendChild(p);
  }
  cap.innerHTML = `${escapeHtml(photo.name || '')}
    <span class="pd-caption-meta">${photo.timestamp ? photo.timestamp.toLocaleString() : ''}${photo.interpolated ? ' · interpolated position' : ''}</span>`;
  lb.hidden = false;
}

function makeMarkerHTML(url, interpolated, isVideo) {
  const style = interpolated ? 'photo-marker interpolated' : 'photo-marker';
  const bg = url ? `background-image:url('${cssEscape(url)}')` : 'background:#888';
  const badge = isVideo ? '<span class="photo-marker-play">&#9654;</span>' : '';
  return `<div class="${style}" style="${bg}">${badge}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOUR ENGINE — cinema mode with route traversal + moving dot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a segment timeline for the tour:
 *   [ transit(route-start → photo1) ]
 *   [ hold @ photo1 (photo shown in split preview) ]
 *   [ transit(photo1 → photo2) ]
 *   [ hold @ photo2 ]
 *   ...
 *   [ transit(photoN → route-end) ]
 *
 * Each segment stores fromRouteIdx / toRouteIdx (integer indices into the
 * route array). The dot's on-screen position is always
 * route[floor(idx)] → route[ceil(idx)] interpolated linearly, so it stays on
 * the polyline that Leaflet already drew.
 */
/**
 * Cumulative distance from route[0] to route[i], in km. Used so transit
 * segments take time proportional to REAL distance, not to the number of
 * GPS trackpoints between them (which can vary wildly with sampling rate).
 */
function computeCumulativeKm(route) {
  const cum = [0];
  for (let i = 1; i < route.length; i++) {
    cum.push(cum[i - 1] + haversineKm(route[i - 1], route[i]));
  }
  return cum;
}

function haversineKm([lat1, lng1], [lat2, lng2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildTourTimeline(routePts, entries) {
  // routePts: array of {lat, lng, time?} from activity.route_points
  // Preserve the FULL polyline as [lat,lng] pairs — the dot slides along
  // this exact array. Sort chronologically (by photo timestamp) so what the
  // user sees in the preview matches how the workout was actually lived.
  const route = routePts.map(p => [p.lat, p.lng]);
  const N = route.length;

  // Match each photo to a route index. Prefer nearest by TIMESTAMP when
  // trackpoint times are available (correct on out-and-back routes where
  // the same lat/lng appears twice); fall back to nearest lat/lng.
  const hasTimes = routePts.some(p => p.time instanceof Date);
  const idxForPhoto = (photo) => {
    if (hasTimes && photo.timestamp instanceof Date) {
      const t = photo.timestamp.getTime();
      let bestIdx = 0, bestDT = Infinity;
      for (let i = 0; i < N; i++) {
        if (!(routePts[i].time instanceof Date)) continue;
        const dt = Math.abs(routePts[i].time.getTime() - t);
        if (dt < bestDT) { bestDT = dt; bestIdx = i; }
      }
      return bestIdx;
    }
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < N; i++) {
      const dLat = route[i][0] - photo.lat;
      const dLng = route[i][1] - photo.lng;
      const d = dLat * dLat + dLng * dLng;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  };

  const routeIdxs = entries.map(e => idxForPhoto(e.photo));

  // Chronological order (what the user experienced). For out-and-back
  // routes this may cause the dot to reverse direction — that's correct.
  const order = entries.map((_, i) => i).sort((a, b) => {
    const ta = entries[a].photo.timestamp?.getTime() ?? 0;
    const tb = entries[b].photo.timestamp?.getTime() ?? 0;
    return ta - tb;
  });

  // Distance-weighted transits: dot moves at a constant km/s regardless of
  // trackpoint density, so it feels the same pace across long straights and
  // dense switchbacks.
  const cumKm = computeCumulativeKm(route);
  const totalKm = cumKm[N - 1] || 0.001;

  const segments = [];
  let cursor = 0;
  let prevIdx = 0;
  for (const oi of order) {
    const entry = entries[oi];
    const targetIdx = routeIdxs[oi];
    const segKm = Math.abs(cumKm[targetIdx] - cumKm[prevIdx]);
    if (segKm > 0.001) {
      const transitMs = Math.max(MIN_TRANSIT_MS, TRANSIT_TOTAL_MS * (segKm / totalKm));
      segments.push({
        kind: 'transit',
        startMs: cursor, endMs: cursor + transitMs,
        fromRouteIdx: prevIdx, toRouteIdx: targetIdx,
      });
      cursor += transitMs;
    }
    const isVideo = !!entry.photo.isVideo;
    const holdMs = isVideo ? VIDEO_HOLD_MS + VIDEO_TAIL_MS : PHOTO_HOLD_MS;
    segments.push({
      kind: 'hold',
      startMs: cursor, endMs: cursor + holdMs,
      atRouteIdx: targetIdx,
      entryIdx: oi,
      isVideo,
    });
    cursor += holdMs;
    prevIdx = targetIdx;
  }
  // Final transit to end of route
  if (prevIdx < N - 1) {
    const segKm = Math.abs(cumKm[N - 1] - cumKm[prevIdx]);
    const transitMs = Math.max(MIN_TRANSIT_MS, TRANSIT_TOTAL_MS * (segKm / totalKm));
    segments.push({
      kind: 'transit',
      startMs: cursor, endMs: cursor + transitMs,
      fromRouteIdx: prevIdx, toRouteIdx: N - 1,
    });
    cursor += transitMs;
  }
  return { segments, totalMs: cursor, route };
}

/** Interpolate along the route by continuous index (0..N-1). */
function routePosAtIdx(route, fIdx) {
  const N = route.length;
  if (N === 0) return null;
  if (N === 1) return route[0];
  const clamped = Math.max(0, Math.min(N - 1, fIdx));
  const lo = Math.floor(clamped);
  const hi = Math.min(N - 1, lo + 1);
  const t = clamped - lo;
  return [
    route[lo][0] + (route[hi][0] - route[lo][0]) * t,
    route[lo][1] + (route[hi][1] - route[lo][1]) * t,
  ];
}

function findSegment(segments, ms) {
  // Segments are in order; small linear scan is fine (< 100 typically).
  for (const s of segments) if (ms >= s.startMs && ms < s.endMs) return s;
  return segments[segments.length - 1] || null;
}

function stepTour(container, entries, delta) {
  if (!_tour || !entries.length) return;
  // Determine current hold segment index (or nearest upcoming) and seek by delta.
  const holds = _tour.segments.filter(s => s.kind === 'hold');
  if (!holds.length) return;
  let curHoldPos = holds.findIndex(h => h.entryIdx === _tour.currentPhotoIdx);
  if (curHoldPos < 0) curHoldPos = 0;
  const nextPos = (curHoldPos + delta + holds.length) % holds.length;
  seekToHold(container, entries, holds[nextPos]);
}

function seekToHold(container, entries, holdSeg) {
  if (!_tour) return;
  _tour.pausedAtElapsed = holdSeg.startMs;
  _tour.startedAt = performance.now() - _tour.pausedAtElapsed;
  _tour.currentPhotoIdx = -1; // force preview refresh on next frame
  if (!_tour.running) {
    // Manually render one frame while paused so user sees the change
    renderTourFrame(performance.now());
  }
}

function toggleTour(container, entries, activity) {
  const playBtn = container.querySelector('#pd-play');
  const cinemaPauseBtn = container.querySelector('#pd-cinema-pause');
  if (_tour && _tour.running) {
    pauseTour(container);
    if (playBtn) playBtn.innerHTML = '&#9654; Play';
    if (cinemaPauseBtn) cinemaPauseBtn.innerHTML = '&#9654;';
    return;
  }
  if (_tour && !_tour.running) {
    resumeTour();
    if (playBtn) playBtn.innerHTML = '&#9646;&#9646; Pause';
    if (cinemaPauseBtn) cinemaPauseBtn.innerHTML = '&#9646;&#9646;';
    return;
  }
  if (!entries.length) return;
  startTour(container, entries, activity);
  if (playBtn) playBtn.innerHTML = '&#9646;&#9646; Pause';
  if (cinemaPauseBtn) cinemaPauseBtn.innerHTML = '&#9646;&#9646;';
}

function startTour(container, entries, activity) {
  // Prefer the activity's route_points (has timestamps) over reading back
  // from the rendered Leaflet polyline — timestamps let us match photos to
  // the correct route position on out-and-back routes.
  const routePts = (activity?.route_points || []).filter(p => p.lat !== null && p.lng !== null);
  if (routePts.length === 0) {
    console.warn('[tour] no route data — cannot animate');
    return;
  }
  const { segments, totalMs, route } = buildTourTimeline(routePts, entries);
  _tour = {
    container, entries, route, segments, totalMs,
    startedAt: performance.now(),
    pausedAtElapsed: 0,
    rafId: null,
    running: true,
    dotMarker: null,
    currentPhotoIdx: -1,
    currentSegKind: null,
    activity,
  };
  enterCinema(container, 'full');
  if (_mapRef && route[0]) {
    // Draw a solid tour polyline covering the FULL route. This sits above
    // renderRoute's pace-colored segments (which have gaps where pace was
    // filtered out) so the dot always visibly sits on the drawn line.
    _tour.tourPolyline = L.polyline(route, {
      color: '#dc2626',
      weight: 5,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
      className: 'tour-route-polyline',
    }).addTo(_mapRef);
    _tour.dotMarker = L.circleMarker(route[0], {
      radius: 11,
      color: '#ffffff',
      weight: 3,
      fillColor: '#dc2626',
      fillOpacity: 1,
      className: 'tour-dot-marker',
    }).addTo(_mapRef);
    // Fit map to the whole route so the entire path is visible while the
    // dot traverses it. Reasonable maxZoom so short routes aren't extreme.
    try {
      const bounds = L.latLngBounds(route);
      _mapRef.fitBounds(bounds, { padding: [60, 60], maxZoom: 15, animate: true });
    } catch {}
  }
  _tour.rafId = requestAnimationFrame(tickTour);
}

function pauseTour() {
  if (!_tour || !_tour.running) return;
  _tour.pausedAtElapsed = performance.now() - _tour.startedAt;
  _tour.running = false;
  if (_tour.rafId) cancelAnimationFrame(_tour.rafId);
  _tour.rafId = null;
  // Pause any playing video in the preview
  const v = _tour.container.querySelector('#pd-preview-media video');
  if (v) try { v.pause(); } catch {}
}

function resumeTour() {
  if (!_tour || _tour.running) return;
  _tour.startedAt = performance.now() - _tour.pausedAtElapsed;
  _tour.running = true;
  // Resume any playing video
  const v = _tour.container.querySelector('#pd-preview-media video');
  if (v) try { v.play(); } catch {}
  _tour.rafId = requestAnimationFrame(tickTour);
}

function tickTour(nowMs) {
  if (!_tour || !_tour.running) return;
  const t = nowMs - _tour.startedAt;
  if (t >= _tour.totalMs) {
    // End of tour — leave dot at end, keep cinema so user can restart
    _tour.pausedAtElapsed = _tour.totalMs;
    _tour.running = false;
    const playBtn = _tour.container.querySelector('#pd-play');
    if (playBtn) playBtn.innerHTML = '&#9654; Play';
    const cinemaPauseBtn = _tour.container.querySelector('#pd-cinema-pause');
    if (cinemaPauseBtn) cinemaPauseBtn.innerHTML = '&#9654;';
    return;
  }
  renderTourFrame(nowMs);
  _tour.rafId = requestAnimationFrame(tickTour);
}

function renderTourFrame(nowMs) {
  if (!_tour) return;
  const t = _tour.running ? (nowMs - _tour.startedAt) : _tour.pausedAtElapsed;
  const seg = findSegment(_tour.segments, t);
  if (!seg) return;

  // Compute continuous route index — differs by segment kind and, for
  // transit, by the current phase (zoom-out / animate / zoom-in).
  let fIdx;
  let phase = null; // 'zoom-out' | 'animate' | 'zoom-in' | null (hold)
  if (seg.kind === 'transit') {
    const local = (t - seg.startMs) / Math.max(1, seg.endMs - seg.startMs);
    if (local < 0.25)      phase = 'zoom-out';
    else if (local < 0.75) phase = 'animate';
    else                    phase = 'zoom-in';

    if (phase === 'zoom-out') {
      fIdx = seg.fromRouteIdx;
    } else if (phase === 'animate') {
      const p = (local - 0.25) / 0.5;
      const eased = easeInOutCubic(Math.max(0, Math.min(1, p)));
      fIdx = seg.fromRouteIdx + (seg.toRouteIdx - seg.fromRouteIdx) * eased;
    } else {
      fIdx = seg.toRouteIdx;
    }
  } else {
    fIdx = seg.atRouteIdx;
  }
  const pos = routePosAtIdx(_tour.route, fIdx);
  // Only re-set the marker's latLng when position actually changed.
  // Calling setLatLng every frame while Leaflet is animating a flyTo causes
  // the dot to appear to slide independently of the map, because the pane
  // transform and per-frame re-projection both fight for the pixel position.
  if (_tour.dotMarker && pos) {
    const last = _tour.dotLastLatLng;
    if (!last || last[0] !== pos[0] || last[1] !== pos[1]) {
      _tour.dotMarker.setLatLng(pos);
      _tour.dotLastLatLng = pos;
    }
  }

  // Cinema layout: full during transit (map fills viewport), split during
  // hold (map | preview 50/50).
  if (seg.kind !== _tour.currentSegKind) {
    _tour.currentSegKind = seg.kind;
    setCinemaMode(_tour.container, seg.kind === 'transit' ? 'full' : 'split');
  }

  if (seg.kind === 'hold') {
    if (seg.entryIdx !== _tour.currentPhotoIdx) {
      _tour.currentPhotoIdx = seg.entryIdx;
      _tour.currentPhase = null;
      const entry = _tour.entries[seg.entryIdx];
      showPreview(_tour.container, entry);
      activate(_tour.container, _tour.entries, seg.entryIdx, { openLightbox: false, fly: false });
      // Hold view: map already zoomed in during the preceding zoom-in phase.
      // No-op here to avoid double flyTo. If the tour started at a hold
      // (first segment), do the zoom-in now.
      if (_mapRef && pos && seg === _tour.segments[0]) {
        try { _mapRef.flyTo(pos, 15, { duration: 0.6, animate: true }); } catch {}
      }
    }
  } else if (seg.kind === 'transit') {
    // Fire one flyTo per phase transition so the map animates in sync
    // with the phase: zoom-out shows the whole transit route slice; the
    // animate phase leaves the map static so the dot moves smoothly;
    // zoom-in dives into the next photo's location.
    const phaseKey = `${seg.startMs}-${phase}`;
    if (_tour.currentPhase !== phaseKey) {
      _tour.currentPhase = phaseKey;
      if (_mapRef) {
        const fromPos = routePosAtIdx(_tour.route, seg.fromRouteIdx);
        const toPos   = routePosAtIdx(_tour.route, seg.toRouteIdx);
        const segMs   = seg.endMs - seg.startMs;
        try {
          if (phase === 'zoom-out') {
            // Fit both endpoints (and the connecting route slice) in view
            const slice = _tour.route.slice(
              Math.min(seg.fromRouteIdx, seg.toRouteIdx),
              Math.max(seg.fromRouteIdx, seg.toRouteIdx) + 1,
            );
            const bounds = L.latLngBounds(slice.length ? slice : [fromPos, toPos]);
            _mapRef.flyToBounds(bounds, {
              duration: (segMs * 0.25) / 1000,
              padding: [60, 60],
              maxZoom: 14,
              animate: true,
            });
          } else if (phase === 'zoom-in') {
            _mapRef.flyTo(toPos, 15, {
              duration: (segMs * 0.25) / 1000,
              animate: true,
            });
          }
          // 'animate' phase: no flyTo — map stays where zoom-out left it
        } catch {}
      }
    }
  }
}

/**
 * Pull the current route out of Leaflet's rendered polylines. We don't hold
 * a direct reference to it, but the last renderRoute() drew it into _mapRef.
 * Fall back to reading from entries' source photos if needed.
 */
function _tour_extractRoute() {
  const route = [];
  if (_mapRef) {
    _mapRef.eachLayer(layer => {
      if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
        const ll = layer.getLatLngs();
        if (Array.isArray(ll) && ll.length > route.length) {
          route.length = 0;
          for (const p of ll) route.push([p.lat, p.lng]);
        }
      }
    });
  }
  return route;
}

function setCinemaMode(container, mode) {
  // Fade the dot out during the CSS layout swap so viewers don't see it
  // "glance off" while the map container is resizing. Faded back in after
  // Leaflet has re-measured its new viewport.
  const dotEl = _tour?.dotMarker?._path;
  if (dotEl) {
    dotEl.style.transition = 'opacity 120ms ease';
    dotEl.style.opacity = '0';
  }
  document.body.classList.toggle('cinema-full', mode === 'full');
  document.body.classList.toggle('cinema-split', mode === 'split');
  // Wait for the CSS transition to finish (320ms) before invalidateSize,
  // then fade the dot back in at its correctly-projected pixel position.
  setTimeout(() => {
    try { _mapRef?.invalidateSize(); } catch {}
    if (dotEl) {
      dotEl.style.opacity = '1';
    }
  }, 350);
}

function enterCinema(container, initialMode = 'full') {
  document.body.classList.add('cinema-tour');
  container.classList.add('cinema');
  setCinemaMode(container, initialMode);
}

function exitCinema(container) {
  document.body.classList.remove('cinema-tour', 'cinema-full', 'cinema-split');
  container.classList.remove('cinema');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { _mapRef?.invalidateSize(); } catch {}
  }));
}

function stopTour(container) {
  if (!_tour) return;
  if (_tour.rafId) cancelAnimationFrame(_tour.rafId);
  if (_tour.dotMarker && _mapRef) {
    try { _mapRef.removeLayer(_tour.dotMarker); } catch {}
  }
  if (_tour.tourPolyline && _mapRef) {
    try { _mapRef.removeLayer(_tour.tourPolyline); } catch {}
  }
  _tour = null;
  if (container) {
    hidePreview(container);
    exitCinema(container);
    const playBtn = container.querySelector('#pd-play');
    if (playBtn) playBtn.innerHTML = '&#9654; Play';
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function showPreview(container, entry) {
  if (!container || !entry) return;
  const preview = container.querySelector('#pd-preview');
  const media   = container.querySelector('#pd-preview-media');
  const cap     = container.querySelector('#pd-preview-caption');
  if (!preview || !media) return;

  const { photo, playableURL } = entry;
  media.innerHTML = '';
  if (photo.isVideo && playableURL) {
    const v = document.createElement('video');
    v.src = playableURL;
    v.autoplay = true;
    v.controls = true;
    v.playsInline = true;
    v.muted = false;
    v.className = 'pd-preview-video';
    media.appendChild(v);
    // Try unmuted first (Play button was a user gesture so this usually
    // works). If the browser still blocks it, fall back to muted playback
    // with a one-tap unmute hint.
    v.play?.().catch(() => {
      v.muted = true;
      v.play?.().catch(() => {});
      const hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'pd-preview-unmute';
      hint.innerHTML = '🔇 Tap to unmute';
      hint.addEventListener('click', () => {
        v.muted = false;
        v.play?.().catch(() => {});
        hint.remove();
      });
      media.appendChild(hint);
    });
  } else if (playableURL) {
    const img = document.createElement('img');
    img.src = playableURL;
    img.alt = photo.name || '';
    img.className = 'pd-preview-img';
    media.appendChild(img);
  } else {
    const fallback = document.createElement('div');
    fallback.className = 'pd-preview-fallback';
    fallback.textContent = 'Preview unavailable';
    media.appendChild(fallback);
  }
  const time = photo.timestamp ? photo.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  cap.textContent = time
    ? `${time}${photo.interpolated ? ' · interpolated' : ''}`
    : (photo.name || '');
  preview.hidden = false;
  preview.setAttribute('aria-hidden', 'false');
}

function hidePreview(container) {
  const preview = container.querySelector('#pd-preview');
  const media   = container.querySelector('#pd-preview-media');
  if (preview) { preview.hidden = true; preview.setAttribute('aria-hidden', 'true'); }
  if (media) media.innerHTML = ''; // stops any playing video
}

function formatDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}
function formatTime(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function cssEscape(s) {
  return String(s).replace(/'/g, "\\'");
}
