/**
 * ============================================================================
 * PEMS PWA SERVICE WORKER — FULL OFFLINE SUPPORT (MOBILE & TABLET)
 * File: sw.js
 * ============================================================================
 */

const CACHE_NAME = 'pems-cache-v1.4.0';
const OFFLINE_URL = './';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './pwa-config.js',
  './js/db.js',
  './js/sync.js',
  './js/pwa-install.js',
  './js/jsQR.js',
  './icons/icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
  './icons/icon.svg',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'
];

// 1. INSTALL EVENT — Cache core App Shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[PEMS SW] Pre-caching static app shell...');
      for (const asset of STATIC_ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn('[PEMS SW] Failed pre-caching asset:', asset, err);
        }
      }
    })
  );
});

// 2. ACTIVATE EVENT — Clean obsolete caches & take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[PEMS SW] Deleting obsolete cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. FETCH EVENT — Stale-While-Revalidate for app, Network-Only for APIs
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // A. Non-GET requests (e.g. POST to Google Apps Script Web App API)
  // MUST NEVER be cached by the service worker
  if (req.method !== 'GET') {
    return;
  }

  // B. Google Apps Script Web App execution URLs
  if (url.hostname.includes('script.google.com') || url.hostname.includes('script.googleusercontent.com')) {
    return;
  }

  // C. HTML Navigation Requests (Loading the app in browser / standalone PWA)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(async () => {
          console.log('[PEMS SW] Offline navigation; serving cached app shell.');
          const cached = await caches.match(req, { ignoreSearch: true });
          if (cached) return cached;
          const indexCached = await caches.match('./index.html', { ignoreSearch: true });
          if (indexCached) return indexCached;
          const fallback = await caches.match(OFFLINE_URL, { ignoreSearch: true });
          if (fallback) return fallback;
          return new Response('Offline: PEMS App Shell is loading from local storage.', {
            headers: { 'Content-Type': 'text/html;charset=utf-8' }
          });
        })
    );
    return;
  }

  // D. Google Fonts & External CDNs (Cache-First with Network fallback)
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('cdnjs.cloudflare.com') || url.hostname.includes('cdn.jsdelivr.net')) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // E. Static Assets (Icons, Images, Scripts) — Stale-While-Revalidate
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const fetchPromise = fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkRes;
      }).catch(() => null);

      return cached || fetchPromise;
    })
  );
});

// 4. BACKGROUND SYNC EVENT (Supported in Android Chrome / Edge)
self.addEventListener('sync', (event) => {
  if (event.tag === 'pems-sync-queue') {
    console.log('[PEMS SW] Background sync event triggered:', event.tag);
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'PEMS_AUTO_SYNC_TRIGGER' });
        });
      })
    );
  }
});

