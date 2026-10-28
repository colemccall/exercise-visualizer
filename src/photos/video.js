/**
 * photos/video.js
 * Generate a first-frame poster (as an object URL) for a video photo item,
 * so it can be shown as the circular marker thumbnail. Result is cached on
 * the photo object so we only decode once.
 */

/**
 * @param {object} photo — normalized photo (must have isVideo + url)
 * @returns {Promise<string|null>} poster object URL or null on failure
 */
export async function ensureVideoPoster(photo) {
  if (!photo.isVideo || !photo.url) return null;
  if (photo._posterURL) return photo._posterURL;
  if (photo._posterPromise) return photo._posterPromise;

  photo._posterPromise = capturePosterFrame(photo.url)
    .then(url => { photo._posterURL = url; return url; })
    .catch(err => { console.warn('[video] poster failed', photo.name, err); return null; });
  return photo._posterPromise;
}

function capturePosterFrame(videoURL) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.crossOrigin = 'anonymous';

    let done = false;
    const cleanup = () => { v.src = ''; v.load?.(); };
    const fail = (msg) => { if (!done) { done = true; cleanup(); reject(new Error(msg)); } };

    v.addEventListener('loadedmetadata', () => {
      // Seek slightly past 0 to avoid a black frame from some codecs.
      try { v.currentTime = Math.min(0.1, (v.duration || 1) / 4); } catch { fail('seek failed'); }
    });

    v.addEventListener('seeked', () => {
      if (done) return;
      try {
        const w = v.videoWidth || 320;
        const h = v.videoHeight || 240;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, w, h);
        canvas.toBlob(blob => {
          done = true;
          cleanup();
          if (!blob) return reject(new Error('toBlob failed'));
          resolve(URL.createObjectURL(blob));
        }, 'image/jpeg', 0.82);
      } catch (err) {
        fail(err.message);
      }
    });

    v.addEventListener('error', () => fail('video load error'));

    // Safety timeout — some browsers hang on unsupported codecs.
    setTimeout(() => fail('poster capture timed out'), 8000);

    v.src = videoURL;
  });
}
