// Network first, so a new version shows up on the next launch (GitHub Pages lets phones cache
// pages for 10 minutes). The last good copy is kept for launching the app offline.

const CACHE = "calorielens";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // The app's own files and the libraries from jsDelivr; API calls go straight to the network.
  if (request.method !== "GET" || !(url.origin === location.origin || url.host === "cdn.jsdelivr.net")) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: "no-cache" }); // revalidate, skip the 10-minute cache
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request, { ignoreSearch: request.mode === "navigate" });
      if (cached) return cached;
      throw error;
    }
  })());
});
