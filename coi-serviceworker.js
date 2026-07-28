/*
 * This file used to register a cross-origin isolation service worker
 * (coi-serviceworker) to enable SharedArrayBuffer for ffmpeg.wasm MP4
 * transcoding. Turned out COEP: require-corp broke the app's ESRI tile
 * loading (tiles don't send Cross-Origin-Resource-Policy).
 *
 * MP4 export now just re-wraps the WebM blob with an .mp4 extension —
 * most players sniff the container and play it fine. This file is kept
 * as a stub so users who cached the old SW automatically deregister it
 * on next visit. Safe to delete once nobody has the old SW cached.
 */
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    let removed = false;
    for (const r of regs) {
      // Only unregister the COI SW (avoid nuking unrelated site workers)
      const url = r.active?.scriptURL || r.installing?.scriptURL || r.waiting?.scriptURL || '';
      if (url.includes('coi-serviceworker')) {
        r.unregister();
        removed = true;
      }
    }
    if (removed && !sessionStorage.getItem('coi-sw-cleaned')) {
      sessionStorage.setItem('coi-sw-cleaned', '1');
      setTimeout(() => location.reload(), 100);
    }
  }).catch(() => {});
}
