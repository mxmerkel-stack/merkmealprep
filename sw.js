/* MerkMealPrep – Offline-Hülle. Netzwerk zuerst, damit Updates sofort ankommen; ohne Netz kommt die letzte Version aus dem Cache. */
const V = 'mmp-v3';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r).then((res) => { const cp = res.clone(); caches.open(V).then((c) => c.put(r, cp)); return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match('index.html')))
  );
});
