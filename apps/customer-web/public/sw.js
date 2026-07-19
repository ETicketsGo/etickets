/* ETicketsGo service worker (ADR-034). Versioned caches, strict same-origin
 * scope, app-shell + static offline support. The authenticated wallet data is
 * NEVER cached here — it lives in user-scoped IndexedDB (see lib/offline). API
 * requests and all non-GET (mutations) are passed straight through to the
 * network, so offline access can never bypass server authorization. */

const VERSION = 'v2';
const APP_CACHE = `etg-app-${VERSION}`;
const STATIC_CACHE = `etg-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/manifest.webmanifest', '/icon.svg'];
const ALLOWED = [APP_CACHE, STATIC_CACHE];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Safe stale-cache cleanup: drop any cache from an older version.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !ALLOWED.includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ── Web Push (v1.4) ── Render a notification from the pushed payload. The payload
// carries no secrets; deep-link target lives in `data.url`.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ETicketsGo';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag,
      data: { url: data.url || '/account/tickets' },
    }),
  );
});

// Focus an existing tab on the target route, or open one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = all.find((c) => c.url.includes(target));
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
    })(),
  );
});

// ── Background Sync (v1.4) ── The SW has no auth token, so it nudges any open
// client to refresh its wallet from the network when connectivity returns.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'etg-wallet-sync') return;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ includeUncontrolled: true });
      all.forEach((c) => c.postMessage({ type: 'SYNC_WALLET' }));
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // same-origin only
  if (url.pathname.startsWith('/api/')) return; // never cache API; app uses IndexedDB

  // Immutable Next static assets + precached files → cache-first.
  if (url.pathname.startsWith('/_next/static/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  // Navigations → network-first, cache the shell, fall back to cache then offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          const cache = await caches.open(APP_CACHE);
          cache.put(request, res.clone());
          return res;
        } catch {
          const cache = await caches.open(APP_CACHE);
          const cached = await cache.match(request);
          return cached || (await cache.match(OFFLINE_URL));
        }
      })(),
    );
  }
});
