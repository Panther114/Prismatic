/* Prismatic offline shell — caches SPA assets after first visit. */
const CACHE = "prismatic-shell-v1";
const PRECACHE = ["/", "/index.html", "/favicon.svg", "/music-note.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
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
  // Never cache API or media streams
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) {
        // Stale-while-revalidate for hashed assets
        event.waitUntil(
          fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
          }).catch(() => undefined),
        );
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response.ok && (url.pathname.startsWith("/assets/") || url.pathname.endsWith(".css") || url.pathname.endsWith(".js") || url.pathname.endsWith(".woff2") || url.pathname === "/" || url.pathname.endsWith(".html") || url.pathname.endsWith(".svg") || url.pathname.endsWith(".png"))) {
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        if (request.mode === "navigate") {
          const shell = await cache.match("/index.html");
          if (shell) return shell;
        }
        throw new Error("Offline and not cached");
      }
    }),
  );
});
