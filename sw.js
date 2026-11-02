/* eslint-env serviceworker */
/**
 * Minimal service worker.
 *
 * Deliberately small. Two jobs only:
 *   1. make the app installable and let the shell open offline;
 *   2. handle notification clicks so tapping an alert focuses the right screen.
 *
 * It must NEVER serve a stale API response: a cached booking status would be
 * actively dangerous in a ride-hailing app, so only same-origin static assets
 * are cached, and every navigation falls back to the network first.
 */

const VERSION = 'ride-v2';
const SHELL = `${VERSION}-shell`;

// The app may be served from a sub-path (GitHub Pages project sites are), so
// everything here is resolved against the worker's own scope rather than '/'.
const BASE = new URL('./', self.registration.scope).pathname;
const PRECACHE = [BASE, `${BASE}index.html`, `${BASE}manifest.webmanifest`, `${BASE}icons/icon.svg`];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch Supabase, tiles, geocoding or routing traffic.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, cached shell only as an offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(`${BASE}index.html`).then((r) => r ?? Response.error()),
      ),
    );
    return;
  }

  // Build assets are content-hashed, so cache-first is safe for them.
  if (url.pathname.startsWith(`${BASE}assets/`) || url.pathname.startsWith(`${BASE}icons/`)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || BASE;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'navigate', url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

/**
 * Raw Web Push, for the case where a push arrives without the FCM SDK being
 * loaded in a page. FCM's own worker (firebase-messaging-sw.js) handles the
 * configured path; this is the fallback.
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { notification: { title: 'Ride', body: event.data.text() } };
  }

  const n = payload.notification ?? payload;

  event.waitUntil(
    self.registration.showNotification(n.title || 'Ride', {
      body: n.body || '',
      icon: `${BASE}icons/icon-192.png`,
      badge: `${BASE}icons/badge-72.png`,
      tag: n.tag || 'ride',
      requireInteraction: n.requireInteraction ?? false,
      data: { url: (payload.data && payload.data.url) || BASE },
    }),
  );
});
