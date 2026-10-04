// Service Worker: macht die App installierbar und offline startbar.
// Netz zuerst (neue Versionen kommen sofort an), ohne Netz die zuletzt geladene Fassung aus dem Zwischenspeicher.
// Gemerkt werden nur eigene Dateien und die Schriften, keine Anfragen an Deezer, Shazam usw.
const CACHE = 'ct-v2';
const keep = url => url.origin === location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// Seite meldet, was sie schon geladen hat (vor dem ersten Start des Service Workers): nachträglich merken
self.addEventListener('message', e => {
  const urls = (e.data?.cache || []).filter(u => { try { return keep(new URL(u)); } catch { return false; } });
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(urls.map(u => c.add(new Request(u, { mode: new URL(u).origin === location.origin ? 'same-origin' : 'no-cors' })).catch(() => {})))));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (!keep(url) || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // eigene Dateien immer beim Server nachfragen (sonst liefert der Browser-Cache bis zu 10 min die alte Fassung,
      // GitHub Pages schickt max-age=600); unverändert kommt nur ein kurzes „304“ zurück
      const fresh = req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache' }) : new Request(req, { cache: 'no-cache' }); // Seitenaufruf lässt sich nicht mit Optionen kopieren
      const res = await fetch(url.origin === location.origin ? fresh : req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') { const index = await cache.match('./'); if (index) return index; }
      throw err;
    }
  })());
});
