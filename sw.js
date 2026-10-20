// Service worker: keeps a copy of the app on the phone so it opens with no signal.
// When you publish changes, bump VERSION so phones pick up the new files.

const VERSION = '1.2.0';
const CACHE = `ai-expense-tracker-${VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/ai.js',
  'js/capture.js',
  'js/db.js',
  'js/entries.js',
  'js/exporter.js',
  'js/fields.js',
  'js/image.js',
  'js/mapper.js',
  'js/queue.js',
  'js/settings.js',
  'js/sheets.js',
  'js/speech.js',
  'js/tabular.js',
  'js/talk.js',
  'js/ui.js',
  'js/util.js',
  'js/xlsx.js',
  'js/zip.js',
  'js/views/entry.js',
  'js/views/excel-setup.js',
  'js/views/export.js',
  'js/views/formats.js',
  'js/views/home.js',
  'js/views/settings.js',
  'js/views/setup.js',
  'js/views/sheets-setup.js',
  'vendor/anthropic-sdk.mjs',
  'vendor/standardwebhooks_1.1.1.mjs',
  'vendor/stablelib_base64_1.0.1.mjs',
  'vendor/fast-sha256_1.3.0.mjs',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))),
  );
  // First install takes over right away; updates wait for the user to tap "Update now".
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ai-expense-tracker-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only the app's own files are cached; AI and Google requests always go to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html').then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)),
  );
});
