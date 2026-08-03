const CACHE_NAME = 'btc-replay-v2';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const relPath = url.pathname.split('/').filter(Boolean).join('/');
  const rel = './' + relPath;

  // 同源资源 + Binance 行情：网络优先，成功后更新缓存；离线时用缓存兜底
  if (url.hostname.includes('binance.com') || url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then(r => r))
    );
    return;
  }

  // CDN（图表库等）：缓存优先，离线可用
  if (e.request.url.startsWith('https://unpkg.com') || e.request.url.startsWith('https://fonts.')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy)).catch(() => {});
          return res;
        }).catch(() => cached);
      })
    );
  }
});
