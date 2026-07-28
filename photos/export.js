/**
 * photos/export.js
 * Render a workout to a shareable WebM video.
 *
 * Timeline model: the video animates the full workout, start to finish,
 * compressed into `totalDurationSec`. The moving position dot traces the
 * entire GPX route (including sections between photos). Photos and videos
 * appear in the lower panel timed to when they were actually taken during
 * the workout.
 *
 * Camera: starts wide (fits the whole route in view), tightens in
 * mid-workout for a follow-cam feel, then zooms back out to a wide finish.
 * We pre-load basemap tiles at the tighter zoom so tiles are available at
 * every step (the wider zoom is a straight downscale of the same tiles —
 * looks fine for a short social clip).
 */

import { drawFrame, makeCamera, loadBasemapTiles, computeBBox, bestZoomForBBox, defaultSize } from './composite.js';
import { ensurePhotoURL } from './heic.js';

const FPS = 30;

/**
 * @param {object} args
 * @param {Activity} args.activity        Must have route_points + photos
 * @param {{
 *   totalDurationSec?: number,   // default 25s — full length of exported clip
 *   size?: {w:number,h:number},
 *   onProgress?: (pct:number, label?:string) => void,
 * }} args.opts
 * @returns {Promise<Blob>}
 */
export async function exportTourVideo({ activity, opts = {} }) {
  const size = opts.size || defaultSize();
  const totalDurationMs = (opts.totalDurationSec ?? 25) * 1000;
  const onProgress = opts.onProgress || (() => {});

  onProgress(0, 'Preparing…');

  // Ensure route is loaded
  if (!activity.route_points && typeof activity._gpxLoader === 'function') {
    try { activity.route_points = await activity._gpxLoader(); } catch {}
  }
  const routePts = (activity.route_points || []).filter(p => p.lat !== null && p.lng !== null);
  if (routePts.length === 0) throw new Error('Route has no valid points');
  const route = routePts.map(p => [p.lat, p.lng]);

  // Photos sorted chronologically
  const photos = (activity.photos || []).slice().sort((a, b) => a.timestamp - b.timestamp);

  // Determine the workout's time span. Prefer GPX timestamps (most accurate);
  // fall back to activity.date + duration_s.
  const timedPts = routePts.filter(p => p.time instanceof Date);
  let startMs, endMs;
  if (timedPts.length >= 2) {
    startMs = timedPts[0].time.getTime();
    endMs   = timedPts[timedPts.length - 1].time.getTime();
  } else if (activity.date && activity.duration_s > 0) {
    startMs = activity.date.getTime();
    endMs   = startMs + activity.duration_s * 1000;
  } else {
    // Last resort: use photo range or an artificial span
    if (photos.length) {
      startMs = photos[0].timestamp.getTime();
      endMs   = photos[photos.length - 1].timestamp.getTime() + 1000;
    } else {
      startMs = 0; endMs = 1000;
    }
  }
  const workoutMs = Math.max(1, endMs - startMs);

  // Pre-load media
  onProgress(5, 'Loading photos…');
  const preloaded = [];
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
        await new Promise(resolve => {
          if (element.readyState >= 1) return resolve();
          element.addEventListener('loadedmetadata', resolve, { once: true });
          element.addEventListener('error', resolve, { once: true });
        });
      } else {
        element = await loadImage(url);
      }
      preloaded.push({ photo: p, element, isVideo: !!p.isVideo });
    } catch (err) {
      console.warn('[export] failed to load', p.name, err);
    }
    onProgress(5 + Math.round((i + 1) / Math.max(1, photos.length) * 15), 'Loading photos…');
  }

  // Compute route bounding box + camera zoom levels
  const mapViewport = { x: 24, y: 24, w: size.w - 48, h: Math.round(size.h * 0.55) };
  const bbox = computeBBox(route);
  const wideZoom = bestZoomForBBox(bbox, mapViewport, 0.85);
  const closeZoom = Math.min(wideZoom + 2, 17);

  // Pre-load basemap tiles at the closer zoom (we downscale for wide shots).
  onProgress(22, 'Loading map tiles…');
  const tileSet = await loadBasemapTiles(bbox, closeZoom, (frac) => {
    onProgress(22 + Math.round(frac * 18), 'Loading map tiles…');
  });
  onProgress(40, 'Recording…');

  // Route fractions for interpolation:
  //   at each ROUTE POINT, what fraction of the workout has elapsed?
  // If we have per-point timestamps we use those (correct spacing); otherwise
  // uniform spacing by index.
  const routeFrac = new Array(routePts.length);
  if (timedPts.length === routePts.length) {
    for (let i = 0; i < routePts.length; i++) {
      routeFrac[i] = (routePts[i].time.getTime() - startMs) / workoutMs;
    }
  } else {
    for (let i = 0; i < routePts.length; i++) {
      routeFrac[i] = i / Math.max(1, routePts.length - 1);
    }
  }

  // Set up recording canvas + MediaRecorder
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

  // Playback loop
  const startedAt = performance.now();
  const currentlyPlayingVideos = new Set();
  await new Promise(resolve => {
    const tick = () => {
      const now = performance.now();
      const t = now - startedAt;
      if (t >= totalDurationMs) {
        currentlyPlayingVideos.forEach(v => { try { v.pause(); } catch {} });
        return resolve();
      }
      const frac = t / totalDurationMs;
      const workoutT = startMs + frac * workoutMs;

      // Camera zoom: wide → close → wide (sinusoidal ease)
      const zoomEase = Math.sin(frac * Math.PI); // 0 at ends, 1 at middle
      const zoomLevel = Math.round(wideZoom + (closeZoom - wideZoom) * zoomEase);

      // Position along route at time workoutT
      const dotLatLng = positionAtTime(route, routeFrac, frac);
      const camera = makeCamera(dotLatLng, zoomLevel, mapViewport);

      // Which photo/video is "active" right now? The nearest photo whose
      // timestamp is within a display window centered on workoutT. Window
      // = totalDurationMs equivalent in workout time / max(photos, 3).
      const activeEntry = pickActivePhoto(preloaded, workoutT, workoutMs, totalDurationMs);

      // If active is a video, start playback (once)
      if (activeEntry?.isVideo && activeEntry.element.paused && !currentlyPlayingVideos.has(activeEntry.element)) {
        try {
          activeEntry.element.currentTime = 0;
          activeEntry.element.play();
          currentlyPlayingVideos.add(activeEntry.element);
        } catch {}
      }
      // Pause any videos that are no longer active
      for (const v of currentlyPlayingVideos) {
        if (activeEntry?.element !== v) { try { v.pause(); } catch {} currentlyPlayingVideos.delete(v); }
      }

      const captionParts = [];
      if (activeEntry?.photo?.timestamp) {
        captionParts.push(activeEntry.photo.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
      } else {
        captionParts.push(new Date(workoutT).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
      }

      drawFrame(ctx, {
        size,
        camera,
        tileSet,
        route,
        progress: frac,
        dotLatLng,
        media: activeEntry?.element || null,
        caption: captionParts.join(' · '),
        title: `${activity.type} · ${formatShortDate(activity.date)}`,
        themeAccent: '#dc2626',
      });

      onProgress(40 + Math.round(frac * 55), 'Recording…');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  await recordingDone;
  stream.getTracks().forEach(track => track.stop());
  onProgress(98, 'Finalizing…');
  await new Promise(r => setTimeout(r, 150));
  const blob = new Blob(chunks, { type: mimeType });
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

/**
 * Given a fraction (0..1) of total video time, find the corresponding
 * position along the route by interpolating between route points whose
 * per-point workout-fraction brackets `frac`.
 */
function positionAtTime(route, routeFrac, frac) {
  if (route.length === 0) return null;
  if (route.length === 1) return route[0];
  // Binary search for the last routeFrac ≤ frac
  let lo = 0, hi = route.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (routeFrac[mid] <= frac) lo = mid; else hi = mid - 1;
  }
  const i = lo;
  const j = Math.min(route.length - 1, i + 1);
  const span = routeFrac[j] - routeFrac[i];
  const local = span > 0 ? (frac - routeFrac[i]) / span : 0;
  return [
    route[i][0] + (route[j][0] - route[i][0]) * local,
    route[i][1] + (route[j][1] - route[i][1]) * local,
  ];
}

/**
 * Pick which photo/video should be displayed at the given workout timestamp.
 * A photo is "active" during a window centered on its timestamp; the window
 * width scales with how many photos there are so they get roughly equal
 * screen time.
 */
function pickActivePhoto(preloaded, workoutT, workoutMs, totalMs) {
  if (!preloaded.length) return null;
  // For videos, the window is at least the video's duration (so it plays
  // through). For photos, the window is a share of the workout, min 2s of
  // wall-clock (converted to workout-time).
  const wallToWorkout = workoutMs / totalMs;
  let best = null, bestDist = Infinity;
  for (const entry of preloaded) {
    if (!entry.photo?.timestamp) continue;
    const ts = entry.photo.timestamp.getTime();
    const dist = Math.abs(ts - workoutT);
    const windowHalf = entry.isVideo
      ? Math.max(1000 * wallToWorkout, (entry.element.duration || 3) * 1000 * wallToWorkout) / 2
      : (2000 * wallToWorkout);
    if (dist <= windowHalf && dist < bestDist) {
      best = entry; bestDist = dist;
    }
  }
  return best;
}

function formatShortDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
