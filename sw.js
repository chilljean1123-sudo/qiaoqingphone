const CACHE_NAME = 'qiaoqingphone-shell-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './presets/default-builtin.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html')))
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    data = { body: event.data ? event.data.text() : '收到一条新消息' };
  }
  const title = data.title || 'AI 小手机';
  const options = {
    body: data.body || '收到一条新消息',
    icon: data.icon || './icons/icon-192.png',
    badge: data.badge || './icons/icon-192.png',
    tag: data.messageId || ('phone-' + (data.charId || 'message')),
    renotify: true,
    data: { url: data.url || './', charId: data.charId || '' }
  };
  event.waitUntil(
    self.registration.showNotification(title, options).then(() =>
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients =>
        Promise.all(clients.map(client => client.postMessage({
          type: 'PHONE_PUSH_RECEIVED',
          charId: data.charId || ''
        })))
      )
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  const charId = event.notification.data?.charId || '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'PHONE_PUSH_OPEN', charId });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
