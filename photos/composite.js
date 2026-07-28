/**
 * photos/composite.js
 * Pure drawing functions for the video-export frame compositor.
 *
 * Frame layout (720x1280, 9:16):
 *   - Top ~55%: map area with CartoDB "light_all" basemap tiles drawn onto
 *     canvas, full route polyline, progressive trail, and a moving
 *     current-position dot.
 *   - Bottom ~40%: current photo or video frame, letterboxed.
 *   - Caption bar: activity title + timestamp.
 *
 * The map supports zoom animation by re-projecting each frame given a
 * center and zoom level. Basemap tiles are pre-fetched for the widest
 * zoom used in the animation.
 */

const DEFAULT_SIZE = { w: 720, h: 1280 };
const MAP_MARGIN = 24;
const PHOTO_MARGIN = 20;

// CartoDB "positron" style — light neutral tiles, CORS-enabled, appropriate
// for our aesthetic. Attribution required if we display long-form (skipped
// in social exports since caption bar covers copyright; still safer to
// include a tiny credit).
const TILE_URL = 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
const TILE_SIZE = 256;

/**
 * Convert a lat/lng to Google-style Mercator pixel coordinates at a given
 * zoom (whole world = 256 * 2^zoom pixels square).
 */
function latLngToWorldPx(lat, lng, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = (lng + 180) / 360 * scale;
  const sinLat = Math.sin(lat * Math.PI / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

/**
 * Choose the highest integer zoom that fits the route's bbox inside the
 * given viewport, with a small padding factor.
 */
export function bestZoomForBBox(bbox, viewport, padding = 0.85) {
  // Try zooms from 18 (very close) down to 2 (world). Pick the largest that
  // fits the whole bbox in the viewport with padding.
  for (let z = 18; z >= 2; z--) {
    const [x1, y1] = latLngToWorldPx(bbox.maxLat, bbox.minLng, z);
    const [x2, y2] = latLngToWorldPx(bbox.minLat, bbox.maxLng, z);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    if (w <= viewport.w * padding && h <= viewport.h * padding) return z;
  }
  return 2;
}

export function computeBBox(latLngs) {
  let minLat = +Infinity, maxLat = -Infinity, minLng = +Infinity, maxLng = -Infinity;
  for (const [lat, lng] of latLngs) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Pre-load basemap tiles covering the given bbox at the given zoom.
 * Returns { tiles: [{x, y, z, img}], minTx, minTy, maxTx, maxTy }.
 * Extends the fetch region by 1 tile in each direction so panning at higher
 * zooms doesn't reveal empty edges immediately.
 */
export async function loadBasemapTiles(bbox, zoom, onProgress = () => {}) {
  const [px1, py1] = latLngToWorldPx(bbox.maxLat, bbox.minLng, zoom);
  const [px2, py2] = latLngToWorldPx(bbox.minLat, bbox.maxLng, zoom);
  const minTx = Math.floor(Math.min(px1, px2) / TILE_SIZE) - 1;
  const maxTx = Math.floor(Math.max(px1, px2) / TILE_SIZE) + 1;
  const minTy = Math.floor(Math.min(py1, py2) / TILE_SIZE) - 1;
  const maxTy = Math.floor(Math.max(py1, py2) / TILE_SIZE) + 1;
  const maxCoord = Math.pow(2, zoom);
  const tiles = [];
  const jobs = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const wrappedX = ((tx % maxCoord) + maxCoord) % maxCoord;
      if (ty < 0 || ty >= maxCoord) continue;
      const url = TILE_URL
        .replace('{z}', zoom)
        .replace('{x}', wrappedX)
        .replace('{y}', ty);
      jobs.push(loadTile(url).then(img => tiles.push({ tx, ty, img })));
    }
  }
  let done = 0;
  const total = jobs.length;
  for (const p of jobs) {
    p.then(() => { done++; onProgress(done / total); }).catch(() => { done++; });
  }
  await Promise.allSettled(jobs);
  return { tiles, zoom };
}

function loadTile(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('tile load failed'));
    img.src = url;
  });
}

/**
 * Given a center lat/lng, a zoom, and a viewport rect on the output canvas,
 * return a projection function (latlng → canvas pixel) plus a function to
 * draw the pre-loaded basemap tiles into that viewport.
 */
export function makeCamera(center, zoom, viewport) {
  const [cx, cy] = latLngToWorldPx(center[0], center[1], zoom);
  const originX = cx - viewport.w / 2;
  const originY = cy - viewport.h / 2;
  return {
    zoom,
    center,
    project(latlng) {
      const [x, y] = latLngToWorldPx(latlng[0], latlng[1], zoom);
      return [x - originX + viewport.x, y - originY + viewport.y];
    },
    drawBasemap(ctx, tileSet) {
      if (!tileSet || !tileSet.tiles) return;
      // Only draw tiles at the same zoom we loaded.
      if (tileSet.zoom !== zoom) return;
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, viewport.x, viewport.y, viewport.w, viewport.h, 18);
      ctx.clip();
      for (const { tx, ty, img } of tileSet.tiles) {
        const dx = tx * TILE_SIZE - originX + viewport.x;
        const dy = ty * TILE_SIZE - originY + viewport.y;
        // Skip tiles fully outside viewport
        if (dx + TILE_SIZE < viewport.x || dx > viewport.x + viewport.w) continue;
        if (dy + TILE_SIZE < viewport.y || dy > viewport.y + viewport.h) continue;
        try { ctx.drawImage(img, dx, dy); } catch {}
      }
      ctx.restore();
    },
  };
}

/**
 * Draw one composited frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} spec
 * @param {{w:number,h:number}} spec.size
 * @param {object} spec.camera         Camera returned by makeCamera()
 * @param {object} spec.tileSet        Pre-loaded tiles from loadBasemapTiles
 * @param {[number,number][]} spec.route  Full route
 * @param {number} spec.progress       0..1 fraction along route
 * @param {[number,number]} spec.dotLatLng
 * @param {HTMLImageElement|HTMLVideoElement|null} spec.media
 * @param {string} spec.caption
 * @param {string} spec.title
 */
export function drawFrame(ctx, spec) {
  const { size, camera, tileSet, route, progress, dotLatLng, media, caption, title } = spec;
  const bg     = spec.themeBg     || '#0f0f13';
  const surf   = spec.themeSurf   || '#f2f2ef';
  const accent = spec.themeAccent || '#dc2626';

  // Whole frame
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size.w, size.h);

  // Map viewport takes ~55% of height
  const mapArea = { x: MAP_MARGIN, y: MAP_MARGIN, w: size.w - MAP_MARGIN * 2, h: Math.round(size.h * 0.55) };

  // Basemap surface (fallback color under tiles)
  ctx.fillStyle = surf;
  roundRect(ctx, mapArea.x, mapArea.y, mapArea.w, mapArea.h, 18);
  ctx.fill();

  // Draw basemap tiles (clipped to mapArea)
  if (camera && tileSet) camera.drawBasemap(ctx, tileSet);

  // Route + trail + dot (clipped to mapArea)
  //
  // Alignment: the dot is drawn at exactly the last vertex of the trail
  // polyline, so it always sits ON the line. Caller passes `dotLatLng` as
  // the interpolated position between route[i] and route[i+1]; we use the
  // same interpolation to place the trail's terminating vertex.
  if (route.length > 1 && camera) {
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, mapArea.x + 1, mapArea.y + 1, mapArea.w - 2, mapArea.h - 2, 17);
    ctx.clip();

    // Full route in a muted color
    ctx.strokeStyle = 'rgba(30,30,40,0.35)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < route.length; i++) {
      const [x, y] = camera.project(route[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Progressive trail: use continuous route index (fIdx) when provided.
    // Draw whole vertices up to floor(fIdx), then a terminal segment to
    // dotLatLng — so the trail's end and the dot are the SAME point.
    const fIdx = (spec.fIdx !== undefined)
      ? spec.fIdx
      : (route.length - 1) * clamp01(progress);
    const lastWhole = Math.max(0, Math.floor(fIdx));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (let i = 0; i <= lastWhole; i++) {
      const [x, y] = camera.project(route[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (dotLatLng) {
      const [dx, dy] = camera.project(dotLatLng);
      ctx.lineTo(dx, dy);
    }
    ctx.stroke();

    // Current-position dot with halo — drawn on top of the trail's endpoint
    if (dotLatLng) {
      const [dx, dy] = camera.project(dotLatLng);
      const grad = ctx.createRadialGradient(dx, dy, 2, dx, dy, 28);
      grad.addColorStop(0, 'rgba(220,38,38,0.55)');
      grad.addColorStop(1, 'rgba(220,38,38,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(dx, dy, 28, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = accent;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(dx, dy, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // Title strip (over the map, top-left)
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const titleText = title || '';
  ctx.font = '700 20px Inter, system-ui, sans-serif';
  const titleW = ctx.measureText(titleText).width + 24;
  roundRect(ctx, mapArea.x + 12, mapArea.y + 12, titleW, 34, 8);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleText, mapArea.x + 24, mapArea.y + 12 + 17);

  // Bottom media area (~40% of height)
  const mediaTop = mapArea.y + mapArea.h + MAP_MARGIN;
  const mediaArea = { x: PHOTO_MARGIN, y: mediaTop, w: size.w - PHOTO_MARGIN * 2, h: size.h - mediaTop - PHOTO_MARGIN - 50 };
  ctx.fillStyle = '#000';
  roundRect(ctx, mediaArea.x, mediaArea.y, mediaArea.w, mediaArea.h, 18);
  ctx.fill();

  if (media) {
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
  } else {
    // No active photo — subtle placeholder
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '500 14px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('· · ·', size.w / 2, mediaArea.y + mediaArea.h / 2);
    ctx.textAlign = 'left';
  }

  // Caption bar
  ctx.fillStyle = '#ffffff';
  ctx.font = '500 18px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillText(caption || '', size.w / 2, size.h - 44);
  ctx.textAlign = 'left';

  // Tiny attribution (required by CartoDB TOS)
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '400 9px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('© OpenStreetMap · CartoDB', size.w - 8, size.h - 14);
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
