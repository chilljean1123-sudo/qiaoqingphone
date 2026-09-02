const CACHE_NAME = 'ai-phone-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }))
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; }
  catch (_) { data = { body: event.data?.text() || '收到一条新消息' }; }

  const title = String(data.title || 'AI 小手机');
  const options = {
    body: String(data.body || '收到一条新消息'),
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: String(data.tag || 'ai-phone-message'),
    renotify: true,
    data: {
      url: String(data.url || './'),
      charId: data.charId ? String(data.charId) : ''
    }
  };

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients =>
      Promise.all(clients.map(client => client.postMessage({ type: 'PHONE_PUSH_RECEIVED', charId: options.data.charId })))
    )
  ]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = new URL(data.url || './', self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
      for (const client of clients) {
        if ('navigate' in client) await client.navigate(targetUrl);
        client.postMessage({ type: 'PHONE_PUSH_OPEN', charId: data.charId || '' });
        return client.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
