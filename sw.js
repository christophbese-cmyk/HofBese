const CACHE = 'heubestellung-v9';

self.addEventListener('install', e => {
  const localAssets = ['./', './index.html', './manifest.json', './qrcode.min.js', './icons/icon-192.png', './icons/icon-512.png'];
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      for (const url of localAssets) {
        try {
          const resp = await fetch(url);
          if (resp.ok) await cache.put(url, resp);
        } catch(err) {}
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API: nicht abfangen — Fehler gehen direkt zur App (wichtig für Offline-Erkennung)
  if (url.pathname.startsWith('/api/')) return;

  if (e.request.method !== 'GET') return;

  // Cache-first Strategie
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => {
        // Fallback für HTML
        if (e.request.destination === 'document' || url.pathname === '/' || url.pathname.endsWith('.html')) {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
