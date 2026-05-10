const CACHE = 'sunstar-v1';
const ASSETS = ['./', './index.html', './css/style.css', './js/app.js', './js/stitch-engine.js', './js/dst-writer.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});