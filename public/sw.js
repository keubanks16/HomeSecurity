// Service worker: offline shell + push notifications
const CACHE = "frontdoor-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/") || url.origin !== location.origin) return;
  // Network first so updates show up, cache as fallback
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Front Door", body: e.data && e.data.text() }; }
  const opts = {
    body: d.body || "",
    tag: d.tag || "door",
    renotify: true,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: d.url || "/" },
    vibrate: d.tag === "ring" ? [200, 100, 200, 100, 400] : [150],
    requireInteraction: d.tag === "ring",
  };
  if (d.image) opts.image = d.image;
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "Front Door", opts),
    self.clients.matchAll({ type: "window" }).then((cs) => cs.forEach((c) => c.postMessage("refresh"))),
  ]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) { if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});
