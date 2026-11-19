// Service worker: makes the app work fully offline and handles updates.
//
// Phones only notice an update when THIS file's bytes change, so the release
// version is written here as well as in version.js. Use `python3 bump_version.py X.Y.Z`
// to change both at once.
const RELEASE = '2.1.0';

importScripts('version.js');
if (self.APP_VERSION !== RELEASE) console.warn(`Version mismatch: sw.js=${RELEASE}, version.js=${self.APP_VERSION}`);

const CACHE = 'expense-manager-' + RELEASE;
const ASSETS = [
  './',
  'index.html',
  'version.js',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/store.js',
  'js/schema.js',
  'js/recurring.js',
  'js/util.js',
  'js/sms.js',
  'js/sms-rules.js',
  'js/trends.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
  // First install: activate immediately. Updates wait until the user taps "Update now".
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('expense-manager-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Cache-first for the app's own files; the app never needs the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    return fetch(req);
  })());
});
