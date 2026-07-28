/**
 * photos/composite.js
 * Pure drawing functions for the video-export frame compositor.
 *
 * The frame is a 9:16 vertical canvas divided in half:
 *   - Top half: hand-drawn map (light bg + route polyline + current-position
 *     dot + progressive trail). No basemap tiles — everything is vector on
 *     canvas, so there are no CORS or third-party dependencies.
 *   - Bottom half: the currently-active photo or the current video frame.
 *   - Overlay: caption bar with timestamp / activity name.
 */

const DEFAULT_SIZE = { w: 720, h: 1280 };
const MAP_MARGIN = 24;
const PHOTO_MARGIN = 20;

/**
 * Prepare per-render projection data given a set of route points and the
 * top-half viewport. Returns a function `project([lat, lng]) → [x, y]`.
 */
export function makeProjection(routeLatLngs, viewport) {
  if (!routeLatLngs.length) {
    return () => [viewport.x + viewport.w / 2, viewport.y + viewport.h / 2];
  }
  let minLat = +Infinity, maxLat = -Infinity;
  let minLng = +Infinity, maxLng = -Infinity;
  for (const [lat, lng] of routeLatLngs) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  // Small padding around the route
  const padLat = (maxLat - minLat) * 0.08 || 0.001;
  const padLng = (maxLng - minLng) * 0.08 || 0.001;
  minLat -= padLat; maxLat += padLat;
  minLng -= padLng; maxLng += padLng;

  // Preserve aspect ratio so the route isn't stretched.
  const latRange = maxLat - minLat;
  const lngRange = maxLng - minLng;
  // Mercator-ish adjustment: at higher latitudes, one degree of longitude
  // is narrower. We approximate with cos(centerLat).
  const centerLat = (minLat + maxLat) / 2;
  const lngScale = Math.cos(centerLat * Math.PI / 180);
  const routeAspect = (lngRange * lngScale) / latRange;
  const viewAspect = viewport.w / viewport.h;

  let scaleW, scaleH;
  if (routeAspect > viewAspect) {
    // Route is wider → fit to width, letterbox top/bottom
    scaleW = viewport.w / (lngRange * lngScale);
    scaleH = scaleW;
  } else {
    scaleH = viewport.h / latRange;
    scaleW = scaleH;
  }
  const routePxW = lngRange * lngScale * scaleW;
  const routePxH = latRange * scaleH;
  const offsetX = viewport.x + (viewport.w - routePxW) / 2;
  const offsetY = viewport.y + (viewport.h - routePxH) / 2;

  return ([lat, lng]) => [
    offsetX + (lng - minLng) * lngScale * scaleW,
    offsetY + (maxLat - lat) * scaleH, // invert Y so north is up
  ];
}

/**
 * Draw one composited frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} spec
 * @param {{w:number,h:number}} spec.size
 * @param {[number,number][]} spec.route      Full route as [lat,lng] pairs
 * @param {(latlng:[number,number]) => [number,number]} spec.project
 * @param {number} spec.progress              0..1 fraction along route (for trail + dot)
 * @param {[number,number]} spec.dotLatLng    Current-position lat/lng
 * @param {HTMLImageElement|HTMLVideoElement|null} spec.media  Active photo/video element
 * @param {string} spec.caption               Text under the media
 * @param {string} spec.title                 Small title at top
 * @param {string} spec.themeBg               Background color for map + frame chrome
 * @param {string} spec.themeAccent           Route color
 */
export function drawFrame(ctx, spec) {
  const { size, route, project, progress, dotLatLng, media, caption, title } = spec;
  const bg     = spec.themeBg     || '#0f0f13';
  const surf   = spec.themeSurf   || '#1a1a22';
  const accent = spec.themeAccent || '#4A90D9';
  const trail  = spec.themeTrail  || '#ffffff';

  // Whole frame
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size.w, size.h);

  // Top-half viewport (map area)
  const mapArea = { x: MAP_MARGIN, y: MAP_MARGIN, w: size.w - MAP_MARGIN * 2, h: size.h / 2 - MAP_MARGIN * 1.5 };
  ctx.fillStyle = surf;
  roundRect(ctx, mapArea.x, mapArea.y, mapArea.w, mapArea.h, 18);
  ctx.fill();

  // Title strip
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 22px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(title || '', mapArea.x + 16, mapArea.y + 14);

  // Route polyline (full, muted)
  if (route.length > 1) {
    ctx.save();
    // Clip to map area so routes never draw over the title chrome edges
    ctx.beginPath();
    roundRect(ctx, mapArea.x + 1, mapArea.y + 1, mapArea.w - 2, mapArea.h - 2, 17);
    ctx.clip();

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < route.length; i++) {
      const [x, y] = project(route[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Progressive trail (bright) up to progress
    const cutIdx = Math.max(1, Math.floor(route.length * clamp01(progress)));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let i = 0; i < cutIdx; i++) {
      const [x, y] = project(route[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Current-position dot with a soft halo
    if (dotLatLng) {
      const [dx, dy] = project(dotLatLng);
      const grad = ctx.createRadialGradient(dx, dy, 2, dx, dy, 26);
      grad.addColorStop(0, 'rgba(255,255,255,0.6)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(dx, dy, 26, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#ff3b30';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(dx, dy, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // Bottom-half media area
  const mediaTop = size.h / 2 + MAP_MARGIN * 0.5;
  const mediaArea = { x: PHOTO_MARGIN, y: mediaTop, w: size.w - PHOTO_MARGIN * 2, h: size.h - mediaTop - PHOTO_MARGIN - 60 };
  ctx.fillStyle = '#000';
  roundRect(ctx, mediaArea.x, mediaArea.y, mediaArea.w, mediaArea.h, 18);
  ctx.fill();

  if (media && media.readyState !== undefined) {
    // Video path (readyState is a video attribute; also present as undefined on images)
  }

  if (media) {
    // Fit media into mediaArea preserving aspect ratio, centered.
    let mw, mh;
    if (media instanceof HTMLVideoElement) {
      mw = media.videoWidth || mediaArea.w;
      mh = media.videoHeight || mediaArea.h;
    } else {
      mw = media.naturalWidth || mediaArea.w;
      mh = media.naturalHeight || mediaArea.h;
    }
    const scale = Math.min(mediaArea.w / mw, mediaArea.h / mh);
    const drawW = mw * scale;
    const drawH = mh * scale;
    const drawX = mediaArea.x + (mediaArea.w - drawW) / 2;
    const drawY = mediaArea.y + (mediaArea.h - drawH) / 2;
    try { ctx.drawImage(media, drawX, drawY, drawW, drawH); } catch {}
  }

  // Caption bar
  ctx.fillStyle = '#ffffff';
  ctx.font = '500 20px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillText(caption || '', size.w / 2, size.h - 50);
  ctx.textAlign = 'left';
}

export function defaultSize() { return { ...DEFAULT_SIZE }; }

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
