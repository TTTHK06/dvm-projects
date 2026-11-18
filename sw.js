/* Service worker: network-first for the app shell and Firebase SDK, cache fallback when offline.
   Firestore and Auth API traffic is not intercepted (the SDK keeps its own offline cache). */
const CACHE = "dvm-register-v2";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  const same = u.origin === self.location.origin;
  const sdk = u.hostname === "www.gstatic.com" && u.pathname.startsWith("/firebasejs/");
  const font = u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com";
  if (!(same || sdk || font)) return;
  e.respondWith(
    fetch(r).then(res => {
      if (res && (res.ok || res.type === "opaque")) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(r, copy));
      }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: r.mode === "navigate" })
      .then(m => m || (r.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});

/* Push: the notifier sends data-only messages through Firebase Cloud Messaging; this worker shows them.
   Every push must show a notification (required by Safari/iOS and Chrome). */
self.addEventListener("push", e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (_) { p = { title: "DVM projects", body: e.data ? e.data.text() : "" }; }
  const d = p.data || p.notification || p;
  const title = d.title || "DVM projects";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(wins => {
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { w.postMessage({ open: target }); return w.focus(); }
    }
    return self.clients.openWindow(target);
  }));
});
