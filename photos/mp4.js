/**
 * photos/mp4.js
 * Lazy-load ffmpeg.wasm and transcode a WebM Blob into an MP4 (H.264 + AAC).
 * Only pulled in when the user picks MP4 in the export modal — the WASM
 * bundle is ~25 MB so we don't want it on every page load.
 */

const FFMPEG_ESM = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const FFMPEG_UTIL = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';
const FFMPEG_CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

let _ffmpeg = null;
let _loading = null;

/**
 * Load ffmpeg.wasm once, cache the instance. Reports load progress via
 * `onProgress(pct, label)` in the 0..100 range for just the load phase.
 */
async function getFFmpeg(onProgress = () => {}) {
  if (_ffmpeg) return _ffmpeg;
  if (_loading) return _loading;

  _loading = (async () => {
    onProgress(0, 'Loading MP4 encoder…');
    const [{ FFmpeg }, util] = await Promise.all([
      import(/* @vite-ignore */ FFMPEG_ESM),
      import(/* @vite-ignore */ FFMPEG_UTIL),
    ]);
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => {
      // Uncomment for debugging: console.log('[ffmpeg]', message);
    });
    ff.on('progress', ({ progress }) => {
      const p = Math.max(0, Math.min(100, Math.round(progress * 100)));
      onProgress(p, 'Transcoding to MP4…');
    });

    const [coreURL, wasmURL] = await Promise.all([
      util.toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      util.toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    ]);
    await ff.load({ coreURL, wasmURL });
    _ffmpeg = ff;
    _ffmpeg._util = util;
    return ff;
  })();
  return _loading;
}

/**
 * Transcode a WebM Blob to MP4 (H.264 video + AAC audio if present).
 * @param {Blob} webmBlob
 * @param {(pct:number, label?:string) => void} [onProgress]
 * @returns {Promise<Blob>} an MP4 Blob
 */
export async function webmToMp4(webmBlob, onProgress = () => {}) {
  onProgress(0, 'Loading MP4 encoder…');
  const ff = await getFFmpeg(onProgress);
  const util = ff._util;

  onProgress(5, 'Writing input…');
  await ff.writeFile('in.webm', await util.fetchFile(webmBlob));

  onProgress(10, 'Transcoding to MP4…');
  // H.264 High Profile at CRF 22 (~visually lossless), fast preset for the
  // fastest usable encode. faststart moves the moov atom to the front so
  // players can begin playback while streaming.
  await ff.exec([
    '-i', 'in.webm',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    'out.mp4',
  ]);

  const data = await ff.readFile('out.mp4');
  // Clean up so subsequent exports don't accumulate files in the virtual FS
  try { await ff.deleteFile('in.webm'); } catch {}
  try { await ff.deleteFile('out.mp4'); } catch {}

  onProgress(100, 'Done');
  return new Blob([data.buffer], { type: 'video/mp4' });
}
