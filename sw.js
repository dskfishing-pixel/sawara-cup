/* サワラ焼肉CUP Service Worker
 * アプリ本体はキャッシュして圏外でも起動できるようにする。
 * データ通信（Supabase）はキャッシュしない。 */
const VERSION = 'scup-v1.2.0';
const SHELL = [
  './', './index.html', './app.css', './config.js', './calc.js', './store.js', './app.js',
  './tide.js', './manifest.webmanifest', './icon-192.png', './apple-touch-icon.png', './schema.sql'
];
const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return; // データは常にネットワーク
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;            // 潮汐APIはアプリ側で保存する

  // 自サイトのファイル：ネットワーク優先（更新を即反映）→ 失敗時キャッシュ
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
    );
    return;
  }
  // 外部ライブラリ・フォント：キャッシュ優先
  if (req.url === LIB || url.hostname.includes('fonts.g')) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
    })));
  }
});
