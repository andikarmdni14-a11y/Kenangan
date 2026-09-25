/* Kerangka aplikasi tersedia luring. API, token, media privat, dan tile peta
   tidak pernah masuk Cache Storage; arsip pribadi dikelola IndexedDB per akun. */
// Keep independent deployments on the same origin from deleting each other's shell.
const PREFIX = `cmv-shell-${encodeURIComponent(self.registration.scope)}-`;
const CACHE = PREFIX + "v5.1-20260925-1";
const SHELL = [
  "./",
  "./index.html",
  "./kenangan/index.html",
  "./jurnal/index.html",
  "./impian/index.html",
  "./surat/index.html",
  "./router.js",
  "./style.css",
  "./supabase-config.js",
  "./offline.js",
  "./main.js",
  "./features.js",
  "./admin.js",
  "./manifest.json",
  "./vendor/supabase.js",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];
const URLS = new Set(
  SHELL.map((p) => new URL(p, self.registration.scope).href),
);
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  // Tunggu tombol muat ulang agar draf/form yang aktif tidak terputus.
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.postMessage({ type: "SHELL_READY" });
    })(),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  // Directory URLs work offline as well as each physical index.html entry point.
  for (const page of ["kenangan", "jurnal", "impian", "surat"]) {
    const path = new URL(`./${page}/`, self.registration.scope).pathname;
    if (
      url.origin === self.location.origin &&
      url.pathname === path.slice(0, -1)
    ) {
      const canonical = new URL(request.url);
      canonical.pathname = path;
      event.respondWith(
        Promise.resolve(Response.redirect(canonical.href, 308)),
      );
      return;
    }
    if (url.pathname === path) url.pathname = path + "index.html";
  }
  if (url.origin !== self.location.origin || !URLS.has(url.href)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE),
        cached = await cache.match(url.href);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic")
          await cache.put(url.href, response.clone());
        return response;
      } catch {
        return new Response(
          "Buka aplikasi sekali saat online untuk menyiapkan mode luring.",
          {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          },
        );
      }
    })(),
  );
});
self.addEventListener("sync", (event) => {
  if (event.tag === "cmv-outbox")
    event.waitUntil(
      (async () => {
        // Kredensial tetap di halaman aplikasi. Browser tanpa Background Sync memakai
        // event online/focus dan pembukaan aplikasi. Tidak menjanjikan kirim saat tertutup.
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of clients)
          client.postMessage({ type: "SYNC_OUTBOX" });
      })(),
    );
});