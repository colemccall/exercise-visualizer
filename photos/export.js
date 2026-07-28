/**
 * photos/export.js
 * Render a workout to a shareable WebM video.
 *
 * Timeline model — mirrors the on-screen cinema tour:
 *   [ transit route-start → photo1 ]
 *   [ hold @ photo1 ]  (photo shown for photoPauseSec)
 *   [ transit photo1 → photo2 ]
 *   [ hold @ photo2 ]
 *   ...
 *   [ transit photoN → route-end ]
 *
 * Transit segments animate the dot smoothly along the actual route polyline
 * (dot always sits ON the line — same continuous route-index math as the
 * trail's terminating vertex). Hold segments freeze the dot at the photo's
 * location while the photo/video plays in the lower panel.
 *
 * Params:
 *   animSpeed         (0.5..3, default 1) — multiplies base transit time
 *   photoPauseSec     (1..8s,  default 3) — hold duration per photo
 *   videoPlaySec      (3..30s, default 8) — cap on video hold; actual is min(dur, cap)
 */

import { drawFrame, makeCamera, loadBasemapTiles, computeBBox, bestZoomForBBox, defaultSize, drawIntroOverlay } from './composite.js';
import { ensurePhotoURL } from './heic.js';

const INTRO_WIDE_ZOOM = 5; // state/country scale

/**
 * Reverse-geocode the route's center to a display label like
 * "Cincinnati, Ohio". Cached on the activity so re-exporting doesn't repeat
 * the network call. Returns null on failure — caller should degrade gracefully.
 */
async function reverseGeocodeCenter(activity, [lat, lng]) {
  if (activity._geocode) return activity._geocode;
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=8&accept-language=en`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const a = j.address || {};
    const place = a.city || a.town || a.village || a.hamlet || a.county;
    const region = a.state || a.state_district || a.region;
    const country = a.country;
    const label = [place, region].filter(Boolean).join(', ') || country || null;
    activity._geocode = label;
    return label;
  } catch {
    return null;
  }
}

const FPS = 30;

/**
 * Estimate total video length in seconds for the given params. Called live
 * from the modal as sliders move — no rendering.
 */
/**
 * Base transit time: seconds per km of route at animSpeed=1×.
 * User-visible formula: transit_seconds = routeKm * SEC_PER_KM / animSpeed.
 * Predictable and consistent — a 5km run at 1× always takes 15s to trace.
 */
const SEC_PER_KM_AT_1X = 3;

/**
 * Compute transit time for a given route length and speed multiplier.
 * Shared between the estimator and the actual renderer so the "≈ Ns"
 * label always matches what actually gets recorded.
 */
function computeTransitSec(routeKm, animSpeed) {
  return (routeKm * SEC_PER_KM_AT_1X) / Math.max(0.1, animSpeed);
}

export function estimateExportDuration(activity, { animSpeed = 1, photoPauseSec = 3, videoPlaySec = 8, intro = true, introSec = 3 } = {}) {
  try {
    const route = (activity.route_points || []).filter(p => p.lat !== null && p.lng !== null);
    const routeKm = totalRouteKm(route);
    const photos = (activity.photos || []);
    const photoCount = photos.filter(p => !p.isVideo).length;
    const videoCount = photos.filter(p => p.isVideo).length;

    const transitSec = computeTransitSec(routeKm, animSpeed);
    const photoTotal = photoCount * photoPauseSec;
    const videoTotal = videoCount * videoPlaySec;
    const introTotal = intro ? introSec : 0;

    return Math.round(transitSec + photoTotal + videoTotal + introTotal);
  } catch (err) {
    console.warn('[export] estimate failed', err);
    return 0;
  }
}

/**
 * @param {object} args
 * @param {Activity} args.activity
 * @param {{
 *   animSpeed?: number,
 *   photoPauseSec?: number,
 *   videoPlaySec?: number,
 *   size?: {w:number,h:number},
 *   onProgress?: (pct:number, label?:string) => void,
 * }} args.opts
 * @returns {Promise<Blob>}
 */
export async function exportTourVideo({ activity, opts = {} }) {
  const size = opts.size || defaultSize();
  const animSpeed = opts.animSpeed ?? 1;
  const photoPauseMs = (opts.photoPauseSec ?? 3) * 1000;
  const videoCapMs   = (opts.videoPlaySec ?? 8) * 1000;
  const mode         = opts.mode || 'overview'; // 'overview' | 'follow'
  const intro        = opts.intro !== false;    // default on
  const introSec     = opts.introSec ?? 3;
  const userTitle    = (opts.title || '').trim() || null;
  const onProgress = opts.onProgress || (() => {});

  onProgress(0, 'Preparing…');

  // Ensure route is loaded
  if (!activity.route_points && typeof activity._gpxLoader === 'function') {
    try { activity.route_points = await activity._gpxLoader(); } catch {}
  }
  const routePts = (activity.route_points || []).filter(p => p.lat !== null && p.lng !== null);
  if (routePts.length === 0) throw new Error('Route has no valid points');
  const route = routePts.map(p => [p.lat, p.lng]);
  const N = route.length;

  // Photos: keep only those with resolvable coordinates
  const photos = (activity.photos || []).filter(p => p.lat !== null && p.lng !== null);
  if (photos.length === 0) throw new Error('No photos to include');

  onProgress(5, 'Loading photos…');
  const preloaded = [];
  const stagingRoot = document.createElement('div');
  // Video elements need to be in the DOM for reliable playback across
  // browsers. Park them off-screen. Cleaned up after recording.
  stagingRoot.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
  document.body.appendChild(stagingRoot);

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const src = p._source || p;
    try {
      const url = p.isVideo ? src.url : await ensurePhotoURL(src);
      if (!url) continue;
      let element;
      if (p.isVideo) {
        element = document.createElement('video');
        element.src = url;
        element.muted = true;
        element.playsInline = true;
        element.preload = 'auto';
        element.crossOrigin = 'anonymous';
        stagingRoot.appendChild(element);
        // Wait until at least one frame is decoded so drawImage produces
        // real pixels (not a black frame). HAVE_CURRENT_DATA = 2.
        const loaded = await new Promise(resolve => {
          const ok   = () => resolve(true);
          const fail = () => {
            const msg = element.error?.message || 'unknown';
            console.warn(`[export] video ${p.name} failed to load: ${msg}. Codec may be unsupported by this browser (Apple HEVC/H.265 doesn't play in Chrome/Firefox).`);
            resolve(false);
          };
          if (element.readyState >= 2) return ok();
          element.addEventListener('loadeddata', ok, { once: true });
          element.addEventListener('canplay', ok, { once: true });
          element.addEventListener('error', fail, { once: true });
          setTimeout(() => resolve(element.readyState >= 2), 4000); // safety
        });
        if (!loaded) continue; // skip unreadable videos rather than embedding a black frame
      } else {
        element = await loadImage(url);
      }
      preloaded.push({
        photo: p,
        element,
        isVideo: !!p.isVideo,
        routeIdx: nearestRouteIdx(route, [p.lat, p.lng]),
      });
    } catch (err) {
      console.warn('[export] failed to load', p.name, err);
    }
    onProgress(5 + Math.round((i + 1) / Math.max(1, photos.length) * 15), 'Loading photos…');
  }
  if (preloaded.length === 0) {
    stagingRoot.remove();
    throw new Error('No renderable photos');
  }

  // Sort by route position (start → end); on out-and-back routes this
  // avoids the dot zig-zagging when photos aren't in strict time order.
  preloaded.sort((a, b) => a.routeIdx - b.routeIdx);

  // Build timeline — same formula as the estimator so the displayed
  // "≈ Ns" matches what actually renders. Distance-weighted so the dot
  // moves at a constant km/s regardless of GPX sampling density.
  const routeKm = totalRouteKm(route);
  const totalTransitMs = computeTransitSec(routeKm, animSpeed) * 1000;
  const cumKm = new Array(N);
  cumKm[0] = 0;
  for (let i = 1; i < N; i++) {
    cumKm[i] = cumKm[i - 1] + haversine(route[i - 1], route[i]);
  }
  const totalCumKm = cumKm[N - 1] || 0.001;

  const segments = [];
  let cursor = 0;
  let prevIdx = 0;
  for (const item of preloaded) {
    const targetIdx = item.routeIdx;
    if (targetIdx !== prevIdx) {
      const segKm = Math.abs(cumKm[targetIdx] - cumKm[prevIdx]);
      const transitMs = totalTransitMs * (segKm / totalCumKm);
      segments.push({
        kind: 'transit',
        startMs: cursor, endMs: cursor + transitMs,
        fromIdx: prevIdx, toIdx: targetIdx,
      });
      cursor += transitMs;
    }
    const holdMs = item.isVideo
      ? Math.min(videoCapMs, Math.max(1500, (item.element.duration || 3) * 1000))
      : photoPauseMs;
    segments.push({
      kind: 'hold',
      startMs: cursor, endMs: cursor + holdMs,
      atIdx: targetIdx,
      item,
    });
    cursor += holdMs;
    prevIdx = targetIdx;
  }
  // Final transit to end of route
  if (prevIdx < N - 1) {
    const segKm = Math.abs(cumKm[N - 1] - cumKm[prevIdx]);
    const transitMs = totalTransitMs * (segKm / totalCumKm);
    segments.push({
      kind: 'transit',
      startMs: cursor, endMs: cursor + transitMs,
      fromIdx: prevIdx, toIdx: N - 1,
    });
    cursor += transitMs;
  }
  const totalMs = cursor;

  // Camera + basemap
  // Two modes:
  //   'overview' — fixed camera showing the whole route the whole time.
  //   'follow'   — camera locked to the dot at a tighter zoom, so viewers
  //                see the terrain around the current position.
  const mapViewport = { x: 24, y: 24, w: size.w - 48, h: Math.round(size.h * 0.55) };
  const bbox = computeBBox(route);
  const overviewZoom = bestZoomForBBox(bbox, mapViewport, 0.85);
  // Follow-cam is 2 levels closer than the overview fit, capped at 15.
  const followZoom = Math.min(15, overviewZoom + 2);
  const tileZoom = mode === 'follow' ? followZoom : overviewZoom;
  const routeCenter = [(bbox.minLat + bbox.maxLat) / 2, (bbox.minLng + bbox.maxLng) / 2];

  onProgress(22, 'Loading map tiles…');
  const tileSets = [];
  const mainTiles = await loadBasemapTiles(bbox, tileZoom, (frac) => {
    onProgress(22 + Math.round(frac * 12), 'Loading map tiles…');
  });
  tileSets.push(mainTiles);
  let introLabel = null;
  if (intro) {
    onProgress(34, 'Loading intro tiles…');
    const wideTiles = await loadBasemapTiles(bbox, INTRO_WIDE_ZOOM, () => {});
    tileSets.push(wideTiles);
    onProgress(37, 'Finding location…');
    introLabel = await reverseGeocodeCenter(activity, routeCenter);
  }
  onProgress(40, 'Recording…');

  // Prepend intro segment if enabled
  if (intro) {
    const introMs = introSec * 1000;
    // Push all existing segments back by introMs, then prepend intro
    for (const s of segments) { s.startMs += introMs; s.endMs += introMs; }
    segments.unshift({
      kind: 'intro',
      startMs: 0, endMs: introMs,
      wideZoom: INTRO_WIDE_ZOOM,
      mainZoom: overviewZoom,
      label: introLabel,
    });
  }
  const finalTotalMs = segments.length ? segments[segments.length - 1].endMs : totalMs;

  // Recording setup
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(FPS);
  const mimeType = pickMimeType();
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const recordingDone = new Promise(resolve => { recorder.onstop = resolve; });
  recorder.start(1000);

  const startedAt = performance.now();
  const playingVideos = new Set();

  await new Promise(resolve => {
    const tick = () => {
      const now = performance.now();
      const t = now - startedAt;
      if (t >= finalTotalMs) {
        playingVideos.forEach(v => { try { v.pause(); } catch {} });
        return resolve();
      }
      const seg = findSegment(segments, t);

      // Intro segment: wide-zoom overview with a "City, State" text overlay.
      // Zoom eases from INTRO_WIDE_ZOOM into the main overview zoom; the
      // route line only becomes readable near the end of the intro when
      // the camera has closed in enough.
      if (seg.kind === 'intro') {
        const local = (t - seg.startMs) / Math.max(1, seg.endMs - seg.startMs);
        const zoom = seg.wideZoom + (seg.mainZoom - seg.wideZoom) * easeOutCubic(local);
        const camera = makeCamera(routeCenter, zoom, mapViewport);
        drawFrame(ctx, {
          size, camera, tileSet: tileSets, route,
          fIdx: 0,
          dotLatLng: null,        // dot hidden during intro
          media: null,
          caption: '',
          title: userTitle || `${activity.type} · ${formatShortDate(activity.date)}`,
          themeAccent: '#dc2626',
        });
        // Text overlay fades in fast, holds, fades out at the end.
        const alpha = local < 0.15 ? (local / 0.15)
                     : local > 0.8 ? (1 - (local - 0.8) / 0.2)
                     : 1;
        drawIntroOverlay(ctx, { size, text: seg.label, alpha });
        onProgress(40 + Math.round((t / finalTotalMs) * 55), 'Recording…');
        return requestAnimationFrame(tick);
      }

      let fIdx, activeItem;
      if (seg.kind === 'transit') {
        const local = (t - seg.startMs) / Math.max(1, seg.endMs - seg.startMs);
        const eased = easeInOutCubic(Math.max(0, Math.min(1, local)));
        fIdx = seg.fromIdx + (seg.toIdx - seg.fromIdx) * eased;
        activeItem = null;
      } else {
        fIdx = seg.atIdx;
        activeItem = seg.item;
        if (activeItem.isVideo && activeItem.element.paused && !playingVideos.has(activeItem.element)) {
          try {
            activeItem.element.currentTime = 0;
            const playPromise = activeItem.element.play();
            if (playPromise && typeof playPromise.catch === 'function') {
              playPromise.catch(err => console.warn('[export] video play rejected', err));
            }
          } catch (err) {
            console.warn('[export] video play threw', err);
          }
          playingVideos.add(activeItem.element);
        }
      }
      for (const v of playingVideos) {
        if (activeItem?.element !== v) { try { v.pause(); } catch {} playingVideos.delete(v); }
      }

      const dotLatLng = routePosAtIdx(route, fIdx);

      const camera = (mode === 'follow' && dotLatLng)
        ? makeCamera(dotLatLng, followZoom, mapViewport)
        : makeCamera(routeCenter, overviewZoom, mapViewport);

      const captionParts = [];
      if (activeItem?.photo?.timestamp) {
        captionParts.push(activeItem.photo.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
      }

      drawFrame(ctx, {
        size, camera, tileSet: tileSets, route,
        fIdx, dotLatLng,
        media: activeItem?.element || null,
        caption: captionParts.join(' · '),
        title: userTitle || `${activity.type} · ${formatShortDate(activity.date)}`,
        themeAccent: '#dc2626',
      });

      onProgress(40 + Math.round((t / finalTotalMs) * 55), 'Recording…');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  await recordingDone;
  stream.getTracks().forEach(t => t.stop());
  onProgress(98, 'Finalizing…');
  await new Promise(r => setTimeout(r, 150));
  const blob = new Blob(chunks, { type: mimeType });
  // Clean up any DOM-attached video elements
  try { stagingRoot.remove(); } catch {}
  onProgress(100, 'Done');
  return blob;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

function nearestRouteIdx(route, latLng) {
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < route.length; i++) {
    const dLat = route[i][0] - latLng[0];
    const dLng = route[i][1] - latLng[1];
    const d = dLat * dLat + dLng * dLng;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

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
  for (const s of segments) if (ms >= s.startMs && ms < s.endMs) return s;
  return segments[segments.length - 1] || null;
}

function totalRouteKm(route) {
  let km = 0;
  for (let i = 1; i < route.length; i++) km += haversine(route[i - 1], route[i]);
  return km;
}

function haversine([lat1, lng1], [lat2, lng2]) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function formatShortDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
