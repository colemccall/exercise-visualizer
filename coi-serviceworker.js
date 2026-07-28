/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
/*!
 * Vendored minimal build. Enables cross-origin isolation (COOP/COEP) on
 * static hosts like GitHub Pages so ffmpeg.wasm's SharedArrayBuffer works.
 * Source: https://github.com/gzuidhof/coi-serviceworker
 */
let coepCredentialless = false;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) return;
        if (ev.data.type === "deregister") {
            self.registration.unregister()
                .then(() => self.clients.matchAll())
                .then(clients => clients.forEach((client) => client.navigate(client.url)));
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, { credentials: "omit" })
            : r;
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) return response;
                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp");
                    if (!coepCredentialless) newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });
} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        // You must set this to true if you're using credentialless.
        window.coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => (typeof chrome !== "undefined") ||
                (typeof navigator.userAgentData !== "undefined" && navigator.userAgentData.brands.filter(b => b.brand == "Chromium").length > 0) || (coepDegrading),
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi,
        };

        const n = navigator;
        if (n.serviceWorker && n.serviceWorker.controller) {
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: window.coi.coepCredentialless(),
            });

            if (window.coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        // If we're already coi: do nothing. Perhaps we've registered before?
        if (window.crossOriginIsolated !== false || !window.isSecureContext) return;

        if (window.coi.shouldRegister()) {
            n.serviceWorker.register(window.document.currentScript.src).then(
                (registration) => {
                    !window.coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                    registration.addEventListener("updatefound", () => {
                        !window.coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                        window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                        window.coi.doReload();
                    });

                    // If the registration is active, but it's not controlling the page
                    if (registration.active && !n.serviceWorker.controller) {
                        !window.coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
                        window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                        window.coi.doReload();
                    }
                },
                (err) => {
                    !window.coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
                }
            );
        }
    })();
}
