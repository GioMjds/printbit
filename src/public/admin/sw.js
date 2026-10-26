// PrintBit Admin Service Worker
// Scope: /admin/
const CACHE_NAME = 'pb-admin-v2';

const PRECACHE_URLS = [
  '/admin/offline.html',
  '/admin/shared.css',
  '/admin/styles.css',
  '/globals.css',
  '/admin/icons/icon-192x192.png',
  '/admin/icons/icon-512x512.png',
  '/admin/icons/icon-maskable-512x512.png',
  '/admin/icons/apple-touch-icon.png',
  '/admin/icons/favicon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name.startsWith('pb-admin-') && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. API requests: Strictly Network-Only (no stale telemetry or financial operations)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Network unavailable: kiosk server is unreachable while offline.'
          }),
          {
            status: 503,
            statusText: 'Service Unavailable',
            headers: {
              'Content-Type': 'application/json; charset=utf-8'
            }
          }
        );
      })
    );
    return;
  }

  // 2. HTML navigations: Network-First with Cache fallback, then offline.html
  const isHtmlNavigation =
    request.mode === 'navigate' ||
    (request.headers.get('accept') && request.headers.get('accept').includes('text/html'));

  if (isHtmlNavigation) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && request.method === 'GET') {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) {
            return cached;
          }
          const offlineFallback = await caches.match('/admin/offline.html');
          if (offlineFallback) {
            return offlineFallback;
          }
          return new Response('Kiosk Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 3. Static assets: Stale-While-Revalidate
  const isStaticAsset =
    url.pathname.startsWith('/admin/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname === '/globals.css';

  if (isStaticAsset) {
    // Service worker file itself should always bypass cache and hit network
    if (url.pathname === '/admin/sw.js') {
      event.respondWith(fetch(request));
      return;
    }

    // Only cache GET requests
    if (request.method !== 'GET') {
      event.respondWith(fetch(request));
      return;
    }

    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const networkFetch = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const copy = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return networkResponse;
          })
          .catch(() => null);

        if (cachedResponse) {
          return cachedResponse;
        }

        return networkFetch.then((networkResponse) => {
          if (networkResponse) {
            return networkResponse;
          }
          return new Response('Resource unavailable offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
      })
    );
    return;
  }

  // 4. Default: Passthrough
  event.respondWith(fetch(request));
});

// ── 5. Push Notifications (Hardware Alerting) ─────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = {
      title: 'PrintBit Kiosk Alert',
      body: event.data ? event.data.text() : 'A critical hardware event occurred.',
    };
  }

  const title = data.title || '🚨 PrintBit Kiosk Alert';
  const timestamp = data.timestamp || Date.now();
  const alertCode = data.code ? String(data.code).toLowerCase() : 'alert';
  const options = {
    body: data.body || 'A critical hardware event occurred on the kiosk.',
    icon: '/admin/icons/icon-192x192.png',
    badge: '/admin/icons/icon-192x192.png',
    tag: 'kiosk-' + alertCode + '-' + timestamp,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [400, 150, 400, 150, 600],
    actions: [
      { action: 'open', title: '🔍 Inspect System' }
    ],
    data: {
      url: data.url || '/admin/system',
      timestamp: timestamp,
      code: data.code,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl =
    (event.notification.data && event.notification.data.url) || '/admin/system';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url.includes('/admin/') && 'focus' in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
