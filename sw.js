// sw.js - offline shell. Bump CACHE on every deploy or the old files stick.
const CACHE = 'artic-v6-m5';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'db.js',
  'logic.js',
  'audio.js',
  'score.js',
  'progress.js',
  'grade.js',
  'manifest.webmanifest',
  'data/words.json',
  'data/words_va.json',
  'data/prompts.json',
  'data/texts.json',
  'data/scenarios.json',
  'data/structures.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first for everything we own. Nothing here ever talks to a third party.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) {
        // refresh in the background, never block the morning on the network
        fetch(req).then(res => {
          if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('index.html'));
    })
  );
});
