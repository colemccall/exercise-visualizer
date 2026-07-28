/**
 * photos/heic.js
 * Lazy-load libheif-js on demand to decode HEIC/HEIF photos into blob URLs
 * so the browser can display them via <img src>. Non-HEIC files bypass this.
 *
 * libheif-js is ~2MB (WASM); we only pay that cost if the user actually drops
 * a HEIC photo. If loading fails, callers should fall back to a placeholder.
 */

const LIBHEIF_URL = 'https://cdn.jsdelivr.net/npm/libheif-js@1.17.1/libheif/libheif.js';

let _libheifPromise = null;
let _decoderPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load libheif-js'));
    document.head.appendChild(s);
  });
}

async function getDecoder() {
  if (!_libheifPromise) _libheifPromise = loadScript(LIBHEIF_URL);
  await _libheifPromise;
  if (!_decoderPromise) {
    // libheif exposes global `libheif` after script load.
    if (typeof libheif !== 'function' && typeof libheif !== 'object') {
      throw new Error('libheif global not found');
    }
    const module = (typeof libheif === 'function') ? libheif() : libheif;
    _decoderPromise = Promise.resolve(module).then(mod => new mod.HeifDecoder());
  }
  return _decoderPromise;
}

/**
 * Decode a HEIC File to an object URL (PNG blob). Cached on the photo object.
 * @param {File} file
 * @returns {Promise<string>} object URL, or throws on failure
 */
export async function decodeHEIC(file) {
  const decoder = await getDecoder();
  const buffer = await file.arrayBuffer();
  const images = decoder.decode(buffer);
  if (!images || !images.length) throw new Error('No images in HEIC');
  const img = images[0];
  const w = img.get_width();
  const h = img.get_height();

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(w, h);

  await new Promise((resolve, reject) => {
    img.display(imageData, (result) => {
      if (!result) reject(new Error('HEIC display() failed'));
      else resolve();
    });
  });
  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) reject(new Error('canvas.toBlob failed'));
      else resolve(URL.createObjectURL(blob));
    }, 'image/png');
  });
}

/**
 * Ensure a photo object has a displayable `url`. For non-HEIC photos this is a
 * no-op. For HEIC, decode once and cache.
 * @param {object} photo — a normalized photo from parsers/photos.js
 * @returns {Promise<string|null>} url or null on failure
 */
export async function ensurePhotoURL(photo) {
  if (photo.url) return photo.url;
  if (!photo.isHEIC || !photo.file) return null;
  if (photo._heicPromise) return photo._heicPromise;
  photo._heicPromise = decodeHEIC(photo.file)
    .then(url => { photo.url = url; return url; })
    .catch(err => { console.warn('[heic] decode failed', photo.name, err); return null; });
  return photo._heicPromise;
}
