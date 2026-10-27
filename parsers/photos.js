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

// Vendored (see vendor/): no third-party script is loaded at runtime.
const EXIFR_URL = new URL('../vendor/exifr.full.esm.mjs', import.meta.url).href;

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

    // Metadata is fetched in two calls:
    //   1. exifr.parse() for timestamp + tz fields. For images we use a
    //      picked list (fast); for videos we parse everything, since
    //      MP4/MOV use QuickTime-atom tag names (CreationDate,
    //      MediaCreateDate, TrackCreateDate) that vary by encoder and
    //      would need to be individually whitelisted.
    //   2. exifr.gps() for GPS. The dedicated helper correctly applies
    //      GPSLatitudeRef / GPSLongitudeRef so western/southern coords
    //      are returned as negative numbers.
    let meta = null;
    let gps  = null;
    try {
      if (video) {
        meta = await exifr.parse(file, true); // parse everything for videos
      } else {
        meta = await exifr.parse(file, {
          pick: [
            'DateTimeOriginal',
            'CreateDate',
            'CreationTime',
            'OffsetTimeOriginal',
            'OffsetTime',
          ],
          translateValues: true,
        });
      }
    } catch (err) {
      console.warn('[photos] metadata parse failed for', file.name, err);
    }
    try {
      gps = await exifr.gps(file);
    } catch (err) {
      // Non-fatal — item just won't have coordinates.
    }

    const timestamp = extractTimestamp(meta);
    const tzOffset  = meta?.OffsetTimeOriginal || meta?.OffsetTime || null;
    const lat = numOrNull(gps?.latitude);
    const lng = numOrNull(gps?.longitude);
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

/**
 * EXIF stores wall-clock time with no zone ("2026:04:10 07:02:00"); exifr hands it
 * back as a Date read in *this machine's* zone. When the photo also records its UTC
 * offset (OffsetTimeOriginal, written by iPhones and most Androids) reinterpret the
 * wall-clock in that offset — otherwise a trip photo viewed from another timezone, or
 * any photo viewed away from where it was taken, lands hours away from its workout.
 *
 * @param {Date} localDate  exifr's Date (wall-clock components in the local zone)
 * @param {string|null} offset  "+HH:MM" / "-HH:MM" / "Z"
 * @returns {Date}
 */
export function applyExifOffset(localDate, offset) {
  if (!(localDate instanceof Date) || isNaN(localDate.getTime()) || !offset) return localDate;
  const m = /^(?:Z|([+-])(\d{2}):?(\d{2}))$/.exec(String(offset).trim());
  if (!m) return localDate;
  const minutes = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const wallClockAsUtc = Date.UTC(
    localDate.getFullYear(), localDate.getMonth(), localDate.getDate(),
    localDate.getHours(), localDate.getMinutes(), localDate.getSeconds(), localDate.getMilliseconds());
  return new Date(wallClockAsUtc - minutes * 60000);
}

function extractTimestamp(meta) {
  if (!meta) return null;
  // Image EXIF: wall-clock time, zone from OffsetTime* when present.
  const exifRaw = meta.DateTimeOriginal || meta.CreateDate;
  if (exifRaw) {
    const d = exifRaw instanceof Date ? exifRaw : new Date(exifRaw);
    if (!isNaN(d.getTime())) return applyExifOffset(d, meta.OffsetTimeOriginal || meta.OffsetTime || null);
  }
  // Video: QuickTime/MP4 atoms are already absolute instants.
  const raw = meta.CreationTime
           || meta.CreationDate       // Apple QuickTime
           || meta.MediaCreateDate    // MP4/MOV standard
           || meta.TrackCreateDate    // MP4 track atom
           || meta['com.apple.quicktime.creationdate'];
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
