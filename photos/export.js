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

import { drawFrame, makeCamera, loadBasemapTiles, computeBBox, bestZoomForBBox, defaultSize, drawIntroFrame } from './composite.js';
import { ensurePhotoURL } from './heic.js';

// State/country-scale zoom for the cinematic intro. One tile at this zoom
// covers ~1200km, and loadBasemapTiles pads by 1 tile in each direction —
// so even a small route bbox gets a 3×3 tile grid = ~3600km of context.
const INTRO_WIDE_ZOOM = 5;

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

// Kept internal — the modal used to display "≈ Ns" but the estimate
// couldn't guarantee accuracy once we moved to frame-count-based rendering,
// so it was removed from the UI. Still handy for debugging.
// eslint-disable-next-line no-unused-vars
function estimateExportDuration(activity, { animSpeed = 1, photoPauseSec = 3, videoPlaySec = 8, intro = true, introSec = 3 } = {}) {
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
  const videoCapMs   = 20_000; // internal cap — videos longer than 20s truncate
  const mode         = opts.mode || 'overview'; // 'overview' | 'follow'
  const intro        = opts.intro !== false;    // default on
  const introSec     = opts.introSec ?? 3;
  const userTitle    = (opts.title || '').trim() || null;
  const format       = opts.format || 'webm';   // 'webm' | 'mp4'
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
        // Decode + pre-scale the photo to the target render size using
        // createImageBitmap. This does two important things:
        //   1. Guarantees GPU texture upload happens NOW (during preload)
        //      rather than the first time drawImage runs at frame time —
        //      which is what was causing the lag spike at each photo hold.
        //   2. Downscales huge iPhone photos (4k+ wide) to ~1280px so
        //      each drawImage call moves 10x less data.
        const rawImg = await loadImage(url);
        element = await createScaledBitmap(rawImg, 1280);
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

  // Load basemap tiles for BOTH the main animation and (if intro is on)
  // the wide state/country view. Both are awaited before we start
  // MediaRecorder, so the intro is never blank while tiles are downloading.
  onProgress(22, 'Loading map tiles…');
  const tileSets = [];
  const mainTiles = await loadBasemapTiles(bbox, tileZoom, (frac) => {
    onProgress(22 + Math.round(frac * 12), 'Loading map tiles…');
  });
  tileSets.push(mainTiles);

  if (intro) {
    // Load the wide "state/country" tileset AND an intermediate zoom
    // level. drawBasemap picks the closest tileset per frame and scales,
    // so having an in-between zoom means the intro's continuous zoom-in
    // is never scaling tiles by more than ~2x — much cleaner than jumping
    // from zoom 5 straight to zoom 12+.
    onProgress(32, 'Loading intro tiles…');
    const wideTiles = await loadBasemapTiles(bbox, INTRO_WIDE_ZOOM, (frac) => {
      onProgress(32 + Math.round(frac * 4), 'Loading intro tiles…');
    });
    tileSets.push(wideTiles);
    const midZoom = Math.round((INTRO_WIDE_ZOOM + overviewZoom) / 2);
    if (midZoom > INTRO_WIDE_ZOOM + 1 && midZoom < overviewZoom - 1) {
      onProgress(36, 'Loading intro tiles…');
      const midTiles = await loadBasemapTiles(bbox, midZoom, (frac) => {
        onProgress(36 + Math.round(frac * 4), 'Loading intro tiles…');
      });
      tileSets.push(midTiles);
    }
  }
  onProgress(40, 'Recording…');

  // Prepend intro segment if enabled. The intro is a cinematic zoom-in:
  // camera starts at INTRO_WIDE_ZOOM (state/country view) and eases into
  // the route's overview zoom over `introSec` seconds. Text overlay uses
  // the trip name the user typed (or a sensible fallback).
  if (intro) {
    const introMs = introSec * 1000;
    const distStr = routeKm >= 1 ? `${routeKm.toFixed(1)} km` : `${Math.round(routeKm * 1000)} m`;
    const durStr = activity.duration_s > 0 ? formatDuration(activity.duration_s) : '';
    const introTitle = userTitle || activity.name || `${activity.type} · ${formatShortDate(activity.date)}`;
    const introSubtitle = [formatShortDate(activity.date), distStr, durStr].filter(Boolean).join(' · ');
    for (const s of segments) { s.startMs += introMs; s.endMs += introMs; }
    segments.unshift({
      kind: 'intro',
      startMs: 0, endMs: introMs,
      wideZoom: INTRO_WIDE_ZOOM,
      mainZoom: overviewZoom,
      title: introTitle,
      subtitle: introSubtitle,
    });
  }
  const finalTotalMs = segments.length ? segments[segments.length - 1].endMs : totalMs;

  // Recording setup. We use captureStream(0) = manual frame capture so
  // that we're in full control of the output frame rate — this avoids the
  // "route stalls then jumps forward" behavior that came from tying our
  // animation to wall-clock time. Each frame we draw explicitly triggers a
  // capture via requestFrame(), so a slow draw = a slower render but a
  // smooth playback video (no dropped frames, no fast-forward jumps).
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0];
  const supportsManualCapture = typeof videoTrack?.requestFrame === 'function';
  if (!supportsManualCapture) {
    // Safari fallback — auto-capture at FPS. Output may have dropped frames
    // if drawing is slow, but at least it records.
    stream.getVideoTracks().forEach(t => t.stop());
    const fallbackStream = canvas.captureStream(FPS);
    stream.addTrack(fallbackStream.getVideoTracks()[0]);
  }
  const mimeType = pickMimeType();
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const recordingDone = new Promise(resolve => { recorder.onstop = resolve; });
  recorder.start(1000);

  const frameDurationMs = 1000 / FPS;
  const totalFrames = Math.ceil(finalTotalMs / frameDurationMs);
  const playingVideos = new Set();

  // Frame-count-based loop. `t` advances by exactly one frame per iteration
  // regardless of how long the draw+capture actually takes. Yields to the
  // browser between frames (via RAF) so the tab stays responsive and any
  // playing <video> elements can advance their internal state.
  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const t = frameIdx * frameDurationMs;
    const seg = findSegment(segments, t);

    if (seg.kind === 'intro') {
      const local = (t - seg.startMs) / Math.max(1, seg.endMs - seg.startMs);
      const zoom = seg.wideZoom + (seg.mainZoom - seg.wideZoom) * easeInOutCubic(local);
      const introViewport = { x: 0, y: 0, w: size.w, h: size.h };
      const camera = makeCamera(routeCenter, zoom, introViewport);
      const textAlpha = local < 0.15 ? (local / 0.15)
                      : local > 0.85 ? Math.max(0, 1 - (local - 0.85) / 0.15)
                      : 1;
      drawIntroFrame(ctx, {
        size, camera, tileSet: tileSets, route,
        title: seg.title, subtitle: seg.subtitle,
        textAlpha, accent: '#dc2626',
      });
    } else {
      let fIdx, activeItem;
      if (seg.kind === 'transit') {
        const local = (t - seg.startMs) / Math.max(1, seg.endMs - seg.startMs);
        const eased = easeInOutCubic(Math.max(0, Math.min(1, local)));
        fIdx = seg.fromIdx + (seg.toIdx - seg.fromIdx) * eased;
        activeItem = null;
      } else {
        fIdx = seg.atIdx;
        activeItem = seg.item;
        if (activeItem.isVideo && !playingVideos.has(activeItem.element)) {
          try {
            activeItem.element.currentTime = 0;
            const p = activeItem.element.play();
            if (p?.catch) p.catch(err => console.warn('[export] video play rejected', err));
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
    }

    // Explicitly capture this canvas state as one video frame. Because
    // requestFrame is called exactly once per iteration, the output video's
    // frame count matches our loop's frame count — no drops, no jumps,
    // and the video plays back at exactly FPS.
    if (supportsManualCapture) {
      try { videoTrack.requestFrame(); } catch {}
    }

    onProgress(40 + Math.round((t / finalTotalMs) * 55), 'Recording…');

    // Yield to the browser so RAF + video playback + UI can breathe.
    await new Promise(r => requestAnimationFrame(r));
  }
  playingVideos.forEach(v => { try { v.pause(); } catch {} });

  recorder.stop();
  await recordingDone;
  stream.getTracks().forEach(t => t.stop());
  onProgress(96, 'Finalizing…');
  await new Promise(r => setTimeout(r, 150));
  let blob = new Blob(chunks, { type: mimeType });
  try { stagingRoot.remove(); } catch {}

  // Optional MP4 transcode. ffmpeg.wasm is lazy-loaded here — only pulled
  // in when the user explicitly picked MP4 in the export modal.
  if (format === 'mp4' && !blob.type.includes('mp4')) {
    onProgress(96, 'Preparing MP4 encoder…');
    try {
      const { webmToMp4 } = await import('./mp4.js');
      blob = await webmToMp4(blob, (pct, label) => {
        // Map the ffmpeg 0..100 into our 96..100 remaining band
        onProgress(96 + Math.round(pct * 0.04), label || 'Transcoding…');
      });
    } catch (err) {
      console.warn('[export] MP4 transcode failed; delivering WebM instead', err);
      // fall through — user still gets the WebM
    }
  }

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
 * Decode + downscale a source image to `targetW` pixels wide (preserving
 * aspect). Returns an ImageBitmap when available (GPU-ready, fastest for
 * drawImage), falling back to a scaled canvas otherwise. Warming the
 * bitmap here means the first drawImage at frame time is a cheap texture
 * lookup, not a decode + upload — which is what caused per-photo lag.
 */
async function createScaledBitmap(sourceImg, targetW) {
  const srcW = sourceImg.naturalWidth || sourceImg.width || targetW;
  const srcH = sourceImg.naturalHeight || sourceImg.height || targetW;
  const scale = Math.min(1, targetW / srcW);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(sourceImg, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high',
      });
    } catch { /* fall through to canvas fallback */ }
  }
  // Canvas fallback (Safari sometimes rejects the resize options above)
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceImg, 0, 0, w, h);
  return canvas; // drawImage accepts HTMLCanvasElement too
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

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatShortDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
