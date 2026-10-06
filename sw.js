// Offline cache for the app shell only. It never caches or sends user data.
const CACHE = "t1dlog-v3";
const ASSETS = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "src/main.js", "src/app.js", "src/dom.js", "src/store.js", "src/crypto.js", "src/model.js", "src/libreview.js",
  "src/timeutil.js", "src/sha256.js", "src/chart.js", "src/exportcsv.js",
  "assets/icon-180.png", "assets/icon-192.png", "assets/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;   // never touch other origins
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
