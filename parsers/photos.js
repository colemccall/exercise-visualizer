/**
 * parsers/photos.js
 * Read EXIF metadata from user-selected photo files (JPG / HEIC / etc.)
 * using the `exifr` library (loaded via CDN ESM).
 *
 * Output shape (normalized Photo):
 * {
 *   id:         string,   // stable per-run identifier
 *   file:       File,     // original File object (kept in memory)
 *   name:       string,   // file.name
 *   url:        string,   // object URL for <img src>. For HEIC without libheif,
 *                         //   this may be null until decoded (see photos/heic.js)
 *   isHEIC:     boolean,  // needs decode for browser display
 *   timestamp:  Date|null,// EXIF DateTimeOriginal (photo taken time)
 *   tzOffset:   string|null, // EXIF OffsetTimeOriginal e.g. "-05:00" if present
 *   lat:        number|null, // EXIF GPSLatitude (signed)
 *   lng:        number|null, // EXIF GPSLongitude (signed)
 *   hasGPS:     boolean,
 * }
 */

const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs';

let _exifrPromise = null;
async function loadExifr() {
  if (!_exifrPromise) {
    _exifrPromise = import(/* @vite-ignore */ EXIFR_URL).then(m => m.default || m);
  }
  return _exifrPromise;
}

function isHEICFile(file) {
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
}

function isVideoFile(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.(mp4|mov|m4v|avi|webm|mkv)$/.test(name)) return true;
  return (file.type || '').startsWith('video/');
}

/**
 * Parse a list of photo files. Signature mirrors other parsers
 * (single file OR File[] via onProgress).
 *
 * @param {File|File[]|FileList} input
 * @param {(pct:number, label?:string) => void} [onProgress]
 * @returns {Promise<object[]>} array of normalized Photo objects
 */
export async function parse(input, onProgress = () => {}) {
  const files = Array.isArray(input)
    ? input
    : (input instanceof FileList ? Array.from(input) : [input]);

  if (!files.length) return [];

  const exifr = await loadExifr();
  const out = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file || !file.name) continue;

    onProgress(Math.round((i / files.length) * 100), `Reading EXIF ${i + 1}/${files.length}`);

    const heic = isHEICFile(file);
    const video = isVideoFile(file);
    let meta = null;
    try {
      meta = await exifr.parse(file, {
        // exifr v7 handles both image EXIF and video (MP4/MOV) atom metadata.
        // For videos the useful keys are CreateDate + GPSLatitude/GPSLongitude.
        pick: [
          'DateTimeOriginal',
          'CreateDate',
          'CreationTime',
          'OffsetTimeOriginal',
          'OffsetTime',
          'GPSLatitude',
          'GPSLongitude',
          'GPSLatitudeRef',
          'GPSLongitudeRef',
        ],
        translateValues: true,
      });
    } catch (err) {
      // Some formats fail silently; keep the item but without timestamp/GPS.
      console.warn('[photos] metadata parse failed for', file.name, err);
    }

    const timestamp = extractTimestamp(meta);
    const tzOffset  = meta?.OffsetTimeOriginal || meta?.OffsetTime || null;
    const lat = numOrNull(meta?.GPSLatitude);
    const lng = numOrNull(meta?.GPSLongitude);
    const hasGPS = lat !== null && lng !== null;

    // Non-HEIC images + videos: hand out an object URL immediately.
    // HEIC files need libheif to decode before browser display.
    const url = heic ? null : URL.createObjectURL(file);

    out.push({
      id: `photo-${i}-${file.name}`,
      file,
      name: file.name,
      url,
      isHEIC: heic,
      isVideo: video,
      timestamp,
      tzOffset,
      lat,
      lng,
      hasGPS,
    });
  }

  onProgress(100, `Read ${files.length} photos`);
  return out;
}

function extractTimestamp(meta) {
  if (!meta) return null;
  const raw = meta.DateTimeOriginal || meta.CreateDate || meta.CreationTime;
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : null;
}

/**
 * Attempt to load prepared data from an optional Python-produced JSON file.
 * Returns [] if not found — this is the fallback for users who ran
 * scripts/prepare_photos.py to pre-extract EXIF for a large photo library.
 */
export async function loadPreparedPhotos(url = 'data/photos.json') {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const arr = await res.json();
    if (!Array.isArray(arr)) return [];
    return arr.map((p, i) => ({
      id: p.id || `prepared-${i}`,
      file: null,
      name: p.file || p.name || `photo-${i}`,
      url: p.file ? `photos/${p.file}` : (p.url || null),
      isHEIC: /\.hei[cf]$/i.test(p.file || p.name || ''),
      timestamp: p.timestamp ? new Date(p.timestamp) : null,
      tzOffset: p.tzOffset || null,
      lat: numOrNull(p.lat),
      lng: numOrNull(p.lng),
      hasGPS: numOrNull(p.lat) !== null && numOrNull(p.lng) !== null,
    }));
  } catch {
    return [];
  }
}
