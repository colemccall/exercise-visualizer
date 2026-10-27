/**
 * parsers/fit.js
 * Minimal Garmin FIT decoder. Strava exports most activities as `.fit.gz`, so
 * without this ~85% of a modern export has no route.
 *
 *   parseFit(bytes)         -> Point[] with a position (same shape as parseGPX)
 *   parseFitRecords(bytes)  -> every record message, including ones with no GPS
 *   parseFitSummary(bytes)  -> session totals, or null
 *
 * Point = { lat, lng, ele, time: Date|null, hr, cad, watts } (+ dist, speed on
 * parseFitRecords output). Never throws: garbage or truncated input yields what
 * decoded so far (possibly []).
 *
 * Handles 12/14-byte headers, little/big-endian definitions, normal and
 * compressed-timestamp headers, developer fields (skipped by size), and several
 * FIT files chained in one buffer. CRCs are not verified.
 */

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);
const SEMI = 180 / 2147483648;

// Base type number (low 5 bits of the type byte) -> [size, invalid sentinel, reader]
// Readers return null for the "invalid" value.
const BASE = {
  0x00: [1, 'u8', 0xFF],            // enum
  0x01: [1, 's8', 0x7F],            // sint8
  0x02: [1, 'u8', 0xFF],            // uint8
  0x83: [2, 's16', 0x7FFF],         // sint16
  0x84: [2, 'u16', 0xFFFF],         // uint16
  0x85: [4, 's32', 0x7FFFFFFF],     // sint32
  0x86: [4, 'u32', 0xFFFFFFFF],     // uint32
  0x07: [1, 'str', null],           // string
  0x88: [4, 'f32', null],           // float32
  0x89: [8, 'f64', null],           // float64
  0x0A: [1, 'u8', 0x00],            // uint8z
  0x8B: [2, 'u16', 0x0000],         // uint16z
  0x8C: [4, 'u32', 0x00000000],     // uint32z
  0x0D: [1, 'u8', 0xFF],            // byte
  0x8E: [8, 's64', null],           // sint64
  0x8F: [8, 'u64', null],           // uint64
  0x90: [8, 'u64', 0],              // uint64z
};

/** Read one scalar; returns null when it holds the type's invalid sentinel. */
function readScalar(dv, off, kind, invalid, little) {
  let v;
  switch (kind) {
    case 'u8': v = dv.getUint8(off); break;
    case 's8': v = dv.getInt8(off); break;
    case 'u16': v = dv.getUint16(off, little); break;
    case 's16': v = dv.getInt16(off, little); break;
    case 'u32': v = dv.getUint32(off, little); break;
    case 's32': v = dv.getInt32(off, little); break;
    case 'f32': v = dv.getFloat32(off, little); return Number.isFinite(v) ? v : null;
    case 'f64': v = dv.getFloat64(off, little); return Number.isFinite(v) ? v : null;
    case 's64': v = Number(dv.getBigInt64(off, little)); return v === 0x7FFFFFFFFFFFFFFF ? null : v;
    case 'u64': v = Number(dv.getBigUint64(off, little)); return v === 0xFFFFFFFFFFFFFFFF || (invalid === 0 && v === 0) ? null : v;
    default: return null;
  }
  return v === invalid ? null : v;
}

/**
 * Walk every data message, calling onMessage(globalNum, fields) where fields is
 * a plain object { fieldNum: value|null } for the fields in `wanted[globalNum]`.
 */
function walk(bytes, wanted, onMessage) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  let pos = 0;

  while (pos + 12 <= len) {
    const headerSize = bytes[pos];
    if ((headerSize !== 12 && headerSize !== 14) || String.fromCharCode(bytes[pos + 8], bytes[pos + 9], bytes[pos + 10], bytes[pos + 11]) !== '.FIT') {
      pos++; // not a header; resync (tolerates trailing junk / odd padding)
      continue;
    }
    const dataSize = dv.getUint32(pos + 4, true);
    let p = pos + headerSize;
    const end = Math.min(len, p + dataSize);
    const defs = new Array(16); // local message type -> definition
    let lastTs = 0;

    try {
      while (p < end) {
        const hdr = bytes[p++];
        let local, isDef = false, hasDev = false, compressed = false, tsOffset = 0;
        if (hdr & 0x80) { // compressed timestamp data message
          compressed = true;
          local = (hdr >> 5) & 0x03;
          tsOffset = hdr & 0x1F;
        } else {
          local = hdr & 0x0F;
          isDef = (hdr & 0x40) !== 0;
          hasDev = (hdr & 0x20) !== 0;
        }

        if (isDef) {
          if (p + 5 > end) break;
          p++; // reserved
          const little = bytes[p++] === 0;
          const globalNum = dv.getUint16(p, little); p += 2;
          const nFields = bytes[p++];
          if (p + nFields * 3 > end) break;
          const fields = [];
          let size = 0;
          const want = wanted[globalNum];
          for (let i = 0; i < nFields; i++) {
            const num = bytes[p], fsize = bytes[p + 1], btype = bytes[p + 2];
            p += 3;
            const base = BASE[btype] || BASE[btype & 0x1F] || [fsize, 'raw', null];
            // Only decode wanted scalar fields that are exactly one element wide.
            const decode = want && want.has(num) && base[1] !== 'str' && base[1] !== 'raw' && fsize === base[0];
            fields.push({ num, off: size, kind: base[1], invalid: base[2], decode });
            size += fsize;
          }
          if (hasDev) {
            if (p >= end) break;
            const nDev = bytes[p++];
            if (p + nDev * 3 > end) break;
            for (let i = 0; i < nDev; i++) size += bytes[p + i * 3 + 1];
            p += nDev * 3;
          }
          defs[local] = { globalNum, little, fields, size, want };
          continue;
        }

        const def = defs[local];
        if (!def || p + def.size > end) break; // data without a definition / truncated
        if (def.want) {
          const out = {};
          for (const f of def.fields) {
            if (f.decode) out[f.num] = readScalar(dv, p + f.off, f.kind, f.invalid, def.little);
          }
          if (compressed) {
            // Reconstruct the full timestamp from the 5-bit offset.
            let ts = (lastTs & ~0x1F) + tsOffset;
            if (tsOffset < (lastTs & 0x1F)) ts += 0x20;
            out[253] = ts;
          }
          if (out[253] !== null && out[253] !== undefined) lastTs = out[253];
          onMessage(def.globalNum, out);
        } else if (compressed) {
          // keep lastTs roughly in sync even for unwanted messages
          let ts = (lastTs & ~0x1F) + tsOffset;
          if (tsOffset < (lastTs & 0x1F)) ts += 0x20;
          lastTs = ts;
        }
        p += def.size;
      }
    } catch { /* truncated or corrupt: keep what we have */ }

    pos = Math.max(end, pos + headerSize) + 2; // + trailing CRC
  }
}

const RECORD_FIELDS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 73, 78, 253]);
const SESSION_FIELDS = new Set([2, 5, 7, 8, 9, 11, 16, 17, 18, 20, 22, 253]);

const toDate = (ts) => (ts === null || ts === undefined ? null : new Date(FIT_EPOCH_MS + ts * 1000));

/** All record messages as points; lat/lng are null where the record has no fix. */
export function parseFitRecords(bytes) {
  const out = [];
  try {
    walk(bytes, { 20: RECORD_FIELDS }, (g, f) => {
      if (g !== 20) return;
      const lat = f[0] != null ? f[0] * SEMI : null;
      const lng = f[1] != null ? f[1] * SEMI : null;
      let ele = null;
      if (f[78] != null) ele = f[78] / 5 - 500;
      else if (f[2] != null) ele = f[2] / 5 - 500;
      const speed = f[73] != null ? f[73] / 1000 : (f[6] != null ? f[6] / 1000 : null);
      out.push({
        lat, lng, ele,
        time: toDate(f[253]),
        hr: f[3] ?? null,
        cad: f[4] ?? null,
        watts: f[7] ?? null,
        dist: f[5] != null ? f[5] / 100 : null,
        speed,
      });
    });
  } catch { /* never throw on garbage */ }
  return out;
}

/** Points with a valid GPS position, in the same shape parseGPX returns. */
export function parseFit(bytes) {
  const pts = [];
  for (const r of parseFitRecords(bytes)) {
    if (r.lat === null || r.lng === null) continue;
    if (Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) continue;
    pts.push({ lat: r.lat, lng: r.lng, ele: r.ele, time: r.time, hr: r.hr, cad: r.cad, watts: r.watts });
  }
  return pts;
}

const SPORTS = { 0: 'generic', 1: 'running', 2: 'cycling', 5: 'swimming', 11: 'walking', 17: 'hiking' };

/** Totals from the (first) session message, or null. */
export function parseFitSummary(bytes) {
  let s = null;
  try {
    walk(bytes, { 18: SESSION_FIELDS }, (g, f) => {
      if (g !== 18 || s) return;
      s = {
        sport: f[5] != null ? (SPORTS[f[5]] || String(f[5])) : null,
        start: toDate(f[2]),
        total_distance_m: f[9] != null ? f[9] / 100 : null,
        total_elapsed_s: f[7] != null ? f[7] / 1000 : null,
        total_timer_s: f[8] != null ? f[8] / 1000 : null,
        avg_hr: f[16] ?? null,
        max_hr: f[17] ?? null,
        calories: f[11] ?? null,
        total_ascent_m: f[22] ?? null,
        avg_cadence: f[18] ?? null,
        avg_power: f[20] ?? null,
      };
    });
  } catch { /* ignore */ }
  return s;
}
