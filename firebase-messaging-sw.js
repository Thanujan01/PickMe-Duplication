/* eslint-env serviceworker */
/**
 * Firebase Cloud Messaging service worker.
 *
 * ONLY used when the VITE_FIREBASE_* variables are configured. The app works
 * without FCM - see src/features/notifications/push.ts.
 *
 * IMPORTANT: a service worker cannot read Vite env vars, so the Firebase web
 * config has to be inlined here. These values are not secrets (they ship in
 * every Firebase web app), but they still must match your project.
 *
 * Fill them in, or leave as-is to keep FCM disabled.
 */

importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

const FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  messagingSenderId: '',
  appId: '',
};

if (FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.messagingSenderId) {
  firebase.initializeApp(FIREBASE_CONFIG);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const n = payload.notification ?? {};
    const data = payload.data ?? {};

    self.registration.showNotification(n.title || 'Ride', {
      body: n.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag || data.booking_id || 'ride',
      // A ride request must not auto-dismiss before the rider sees it.
      requireInteraction: data.type === 'ride_request',
      data: { url: data.url || (data.type === 'ride_request' ? '/rider' : '/') },
    });
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

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
