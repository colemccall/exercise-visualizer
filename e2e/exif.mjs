/**
 * e2e/exif.mjs
 * Builds a JPEG with EXIF (DateTimeOriginal, OffsetTimeOriginal, optional GPS) by
 * splicing an APP1 segment into an existing JPEG, so the smoke test can exercise
 * the Photo Tour without binary fixtures or Python.
 */

function ascii(str) {
  const b = new Uint8Array(str.length + 1);
  for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i);
  return b; // trailing NUL
}

function rationals(values) {
  const dv = new DataView(new ArrayBuffer(values.length * 8));
  values.forEach(([num, den], i) => { dv.setUint32(i * 8, num, true); dv.setUint32(i * 8 + 4, den, true); });
  return new Uint8Array(dv.buffer);
}

function dms(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 10000);
  return rationals([[d, 1], [m, 1], [s, 10000]]);
}

/** Little-endian TIFF block holding the Exif (and optionally GPS) IFDs. */
function tiff({ datetime, offset, lat, lon }) {
  const hasGps = lat !== undefined;
  const parts = []; // [offset, bytes]
  const ifd0At = 8;
  const ifd0Len = 2 + 12 * (hasGps ? 2 : 1) + 4;
  const exifAt = ifd0At + ifd0Len;
  const exifLen = 2 + 12 * 2 + 4;
  const dtAt = exifAt + exifLen, dt = ascii(datetime);          // 20 bytes
  const offAt = dtAt + dt.length, off = ascii(offset);          // 7 bytes
  let gpsAt = offAt + off.length + ((offAt + off.length) % 2);   // keep word alignment
  const gpsLen = 2 + 12 * 4 + 4;
  const latAt = gpsAt + gpsLen, lonAt = latAt + 24;
  const total = hasGps ? lonAt + 24 : gpsAt;

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49], 0); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);

  const entry = (at, i, tag, type, count, valueOrOffset, inlineBytes) => {
    const p = at + 2 + i * 12;
    dv.setUint16(p, tag, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, count, true);
    if (inlineBytes) buf.set(inlineBytes, p + 8); else dv.setUint32(p + 8, valueOrOffset, true);
  };

  dv.setUint16(ifd0At, hasGps ? 2 : 1, true);
  entry(ifd0At, 0, 0x8769, 4, 1, exifAt);
  if (hasGps) entry(ifd0At, 1, 0x8825, 4, 1, gpsAt);

  dv.setUint16(exifAt, 2, true);
  entry(exifAt, 0, 0x9003, 2, dt.length, dtAt); buf.set(dt, dtAt);
  entry(exifAt, 1, 0x9011, 2, off.length, offAt); buf.set(off, offAt);

  if (hasGps) {
    dv.setUint16(gpsAt, 4, true);
    entry(gpsAt, 0, 1, 2, 2, 0, ascii(lat >= 0 ? 'N' : 'S'));
    entry(gpsAt, 1, 2, 5, 3, latAt); buf.set(dms(lat), latAt);
    entry(gpsAt, 2, 3, 2, 2, 0, ascii(lon >= 0 ? 'E' : 'W'));
    entry(gpsAt, 3, 4, 5, 3, lonAt); buf.set(dms(lon), lonAt);
  }
  return buf;
}

/**
 * @param {Uint8Array} jpeg  a valid JPEG
 * @param {{datetime: string, offset: string, lat?: number, lon?: number}} meta  datetime like "2026:04:10 07:02:00"
 */
export function withExif(jpeg, meta) {
  const t = tiff(meta);
  const header = new TextEncoder().encode('Exif\0\0');
  const len = 2 + header.length + t.length;
  const app1 = new Uint8Array(2 + len);
  app1.set([0xff, 0xe1, len >> 8, len & 0xff], 0);
  app1.set(header, 4); app1.set(t, 4 + header.length);
  const out = new Uint8Array(2 + app1.length + jpeg.length - 2);
  out.set([0xff, 0xd8], 0); out.set(app1, 2); out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}
