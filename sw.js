// Service Worker: App offline startbar machen
const VERSION = 'lernapp-v56';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/drive.js', 'js/ai.js', 'js/extract.js', 'js/ris.js',
  'js/planner.js', 'js/ui.js', 'js/processing.js', 'js/views-subject.js', 'js/views-learn.js',
  'js/views-main.js', 'js/chat.js', 'js/jobs.js', 'js/theme.js', 'js/calendar.js', 'js/law.js', 'js/costs.js', 'js/structure.js', 'js/merge.js',
  'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // APIs nie cachen
  if (/googleapis\.com|anthropic\.com|openai\.com|accounts\.google\.com|\/ris-api\/|\/ris-doc\/|\/api\/|\/anthropic-api\/|bka\.gv\.at/.test(url.href)) return;
  // Bibliotheken vom CDN: einmal laden, dann aus dem Cache
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === location.origin) {
    // Netzwerk zuerst (damit Updates sofort ankommen), sonst Cache
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  }
});
