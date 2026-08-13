/* AES service worker — cache shell + show notification hints. */
const CACHE = 'aes-shell-v1';
const PRECACHE = ['/', '/assets/app.css', '/assets/app.js', '/logo-mark.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => undefined)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        if (res.ok && url.origin === self.location.origin) {
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});

self.addEventListener('push', (event) => {
  let title = 'AES';
  let body = 'You have a new notification';
  try {
    const data = event.data ? event.data.json() : {};
    title = data.title || title;
    body = data.body || body;
  } catch {
    /* ignore */
  }
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/logo-mark.svg' }));
});
