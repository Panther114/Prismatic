/* Prismatic offline shell — web only. Bump CACHE on every breaking UI release. */
const CACHE = "prismatic-shell-v3";

self.addEventListener("install", (event) => {
  // Activate immediately; do not precache index.html (it must stay network-first).
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const {request} = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Navigations + HTML: always network-first so upgrades never show a stale shell.
  const isNavigate = request.mode === "navigate"
    || url.pathname === "/"
    || url.pathname.endsWith(".html");

  if (isNavigate) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE);
          return (await cache.match(request)) || (await cache.match("/index.html")) || Response.error();
        }),
    );
    return;
  }

  // Hashed assets: stale-while-revalidate
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => undefined);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const response = await network;
      if (response) return response;
      throw new Error("Offline and not cached");
    }),
  );
});
