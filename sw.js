/* Cache HANYA kerangka publik. Tidak menyimpan sesi, API Supabase, atau media. */
const CACHE_PREFIX = "cmv-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v3-shared`;
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./supabase-config.js",
  "./main.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];
const URLS = new Set(
  SHELL.map((path) => new URL(path, self.registration.scope).href),
);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  // Versi baru menunggu persetujuan tombol muat ulang; tidak memutus form unggahan.
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || !URLS.has(url.href))
    return;
  // Allowlist ini tidak pernah mencakup endpoint /auth, /rest, /storage atau blob:.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(request, {
          signal: controller.signal,
          cache: "no-cache",
        });
        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
          return response;
        }
        const cached = await cache.match(request);
        return cached || response;
      } catch {
        const cached = await cache.match(request);
        return (
          cached ||
          new Response("Sambungkan internet untuk membuka halaman ini.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      } finally {
        clearTimeout(timeout);
      }
    })(),
  );
});