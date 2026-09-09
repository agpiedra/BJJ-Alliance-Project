// Minimal service worker whose only job is to satisfy PWA-installability
// requirements (a controlling SW is one of the checks browsers make before
// offering "Add to Home Screen" / install prompts).
//
// Deliberately NOT a full app-shell-caching PWA (see Task 7's brief, spec
// §10): Next.js's JS/CSS bundle URLs are content-hashed and change on every
// build, so pre-caching them here would be fragile and would need to be kept
// in sync with the build output. Background Sync API support is also
// inconsistent across browsers, so this worker does not attempt to own the
// offline-queue flush either — that logic lives client-side in
// kiosk-client.tsx, driven by `navigator.onLine` and the `online` window
// event (src/lib/kiosk/offline-queue.ts).
//
// `fetch` here just falls through to the network for everything; the only
// caching behavior is the browser's own HTTP cache.

self.addEventListener("install", () => {
  // Activate this worker as soon as it finishes installing, without waiting
  // for existing tabs to close, so a kiosk tablet picks up a new SW promptly.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // No-op: let the browser handle every request normally. A registered
  // fetch handler (even one that does nothing) is what makes this worker
  // count toward installability in Chromium-based browsers.
});
