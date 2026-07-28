/**
 * photos/export.js
 * Build a per-workout tour video from the same photo state the on-screen tour
 * uses. Output: WebM via canvas.captureStream + MediaRecorder.
 *
 * Frame composition lives in composite.js. This module owns the timeline,
 * the frame loop, and MediaRecorder lifecycle.
 *
 * Rough timeline for each entry:
 *   [transition (interp map dot)] [hold (still photo) OR play (video)]
 * Videos ignore the photo hold and use their own duration (capped).
 */

import { drawFrame, makeProjection, defaultSize } from './composite.js';
import { ensurePhotoURL } from './heic.js';

const FPS = 30;
const MIN_TRANSITION_MS = 400;
const VIDEO_MAX_MS = 20000;

/**
 * @param {object} args
 * @param {Activity} args.activity  Must have route_points + photos populated
 * @param {{
 *   speedMultiplier?: number,   // 0.5..3, scales transition speed (default 1)
 *   photoHoldMs?: number,       // default 3000
 *   videoTailMs?: number,       // default 1000
 *   size?: {w:number,h:number}, // default 720x1280
 *   onProgress?: (pct:number, label?:string) => void,
 * }} args.opts
 * @returns {Promise<Blob>}  A WebM Blob of the rendered tour
 */
export async function exportTourVideo({ activity, opts = {} }) {
  const size = opts.size || defaultSize();
  const speed = opts.speedMultiplier ?? 1;
  const photoHoldMs = opts.photoHoldMs ?? 3000;
  const videoTailMs = opts.videoTailMs ?? 1000;
  const onProgress = opts.onProgress || (() => {});

  onProgress(0, 'Preparing…');

  // Ensure route is loaded
  if (!activity.route_points && typeof activity._gpxLoader === 'function') {
    try { activity.route_points = await activity._gpxLoader(); } catch {}
  }
  const route = (activity.route_points || [])
    .filter(p => p.lat !== null && p.lng !== null)
    .map(p => [p.lat, p.lng]);
  const photos = (activity.photos || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  if (photos.length === 0) throw new Error('No photos to export');

  // Preload media (images + video elements). Videos we DON'T fully preload —
  // we just create the element; the draw loop pulls frames from it when active.
  onProgress(5, 'Loading media…');
  const items = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const src = p._source || p;
    const url = p.isVideo ? src.url : await ensurePhotoURL(src);
    if (!url) continue;
    let element;
    if (p.isVideo) {
      element = document.createElement('video');
      element.src = url;
      element.muted = true; // for MVP we don't composite audio
      element.playsInline = true;
      element.preload = 'auto';
      await new Promise(resolve => {
        if (element.readyState >= 1) resolve();
        else element.addEventListener('loadedmetadata', resolve, { once: true });
        element.addEventListener('error', resolve, { once: true });
      });
    } else {
      element = await loadImage(url);
    }
    items.push({ photo: p, element, isVideo: !!p.isVideo });
    onProgress(5 + Math.round((i / photos.length) * 20), 'Loading media…');
  }
  if (items.length === 0) throw new Error('No renderable photos');

  // Build a projection over the entire route bbox.
  const project = makeProjection(route.length ? route : items.map(it => [it.photo.lat, it.photo.lng]), {
    x: 0, y: 0, w: size.w, h: size.h / 2,
  });

  // Build a route-fraction index for the current-dot position: for each item,
  // find the closest route point index; that's the "progress" endpoint.
  const routeFractions = items.map(it => nearestRouteFraction(route, [it.photo.lat, it.photo.lng]));

  // Build timeline
  onProgress(25, 'Planning timeline…');
  const timeline = [];
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const transitionMs = Math.max(MIN_TRANSITION_MS, Math.round(800 / speed));
    if (i > 0) {
      timeline.push({
        kind: 'transition',
        from: i - 1, to: i,
        fromFrac: routeFractions[i - 1],
        toFrac: routeFractions[i],
        start: cursor,
        end: cursor + transitionMs,
      });
      cursor += transitionMs;
    }
    const holdMs = it.isVideo
      ? Math.min(VIDEO_MAX_MS, Math.round((it.element.duration || 3) * 1000)) + videoTailMs
      : photoHoldMs;
    timeline.push({
      kind: 'hold',
      idx: i,
      atFrac: routeFractions[i],
      start: cursor,
      end: cursor + holdMs,
      isVideo: it.isVideo,
    });
    cursor += holdMs;
  }
  const totalMs = cursor;

  // Set up rendering canvas + MediaRecorder
  onProgress(30, 'Recording…');
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(FPS);
  const mimeType = pickMimeType();
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const recordingDone = new Promise(resolve => { recorder.onstop = resolve; });
  recorder.start(1000);

  // Playback loop
  const startedAt = performance.now();
  const activeVideos = new Set();
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      const t = now - startedAt;
      if (t >= totalMs) {
        // Ensure any playing video is paused
        activeVideos.forEach(v => { try { v.pause(); } catch {} });
        return resolve();
      }

      const seg = timeline.find(s => t >= s.start && t < s.end) || timeline[timeline.length - 1];

      let currentItem, dotFrac;
      if (seg.kind === 'transition') {
        const localT = (t - seg.start) / (seg.end - seg.start);
        const eased = easeInOutCubic(clamp01(localT));
        dotFrac = seg.fromFrac + (seg.toFrac - seg.fromFrac) * eased;
        currentItem = items[seg.from];
      } else {
        dotFrac = seg.atFrac;
        currentItem = items[seg.idx];
        // Start video playback if this is its first tick
        if (seg.isVideo && currentItem.element.paused && !activeVideos.has(currentItem.element)) {
          try { currentItem.element.currentTime = 0; currentItem.element.play(); } catch {}
          activeVideos.add(currentItem.element);
        }
      }

      const dotLatLng = interpAlongRoute(route, dotFrac);
      const caption = currentItem?.photo?.timestamp
        ? currentItem.photo.timestamp.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';

      drawFrame(ctx, {
        size,
        route,
        project,
        progress: dotFrac,
        dotLatLng,
        media: currentItem?.element || null,
        caption,
        title: `${activity.type} · ${formatShortDate(activity.date)}`,
        themeBg: '#0f0f13',
        themeSurf: '#1a1a22',
        themeAccent: '#4A90D9',
      });

      // Progress callback (throttled)
      const pct = 30 + Math.round((t / totalMs) * 65);
      onProgress(pct, 'Recording…');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  await recordingDone;
  stream.getTracks().forEach(t => t.stop());
  onProgress(98, 'Finalizing…');

  // Give the recorder a beat to flush the final chunk
  await new Promise(r => setTimeout(r, 100));
  const blob = new Blob(chunks, { type: mimeType });
  onProgress(100, 'Done');
  return blob;
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4', // Safari 14.1+
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
    img.onerror = () => reject(new Error('image load failed: ' + url));
    img.src = url;
  });
}

/**
 * Given an [lat,lng] point, find the nearest index in the route and return
 * that index as a 0..1 fraction of route length.
 */
function nearestRouteFraction(route, latLng) {
  if (route.length === 0) return 0;
  if (route.length === 1) return 0;
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < route.length; i++) {
    const d = haversineSq(route[i], latLng);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx / (route.length - 1);
}

/** Given a fraction 0..1 along the route, return the interpolated [lat,lng]. */
function interpAlongRoute(route, frac) {
  if (route.length === 0) return null;
  if (route.length === 1) return route[0];
  const t = clamp01(frac) * (route.length - 1);
  const lo = Math.floor(t);
  const hi = Math.min(route.length - 1, lo + 1);
  const f = t - lo;
  return [
    route[lo][0] + (route[hi][0] - route[lo][0]) * f,
    route[lo][1] + (route[hi][1] - route[lo][1]) * f,
  ];
}

function haversineSq(a, b) {
  const dLat = a[0] - b[0];
  const dLng = a[1] - b[1];
  return dLat * dLat + dLng * dLng;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

function formatShortDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
