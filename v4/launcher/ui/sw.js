// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The phone app's service worker. It keeps the app's own screens ready so it opens at once and shows a calm message when
// there is no connection. It never keeps anything from /api or /auth (what the bot says is always asked for fresh).
'use strict';
const KEEP = 'goodboy-shell-v3';
const SHELL = ['/', '/ui.css', '/boot.css', '/music.css', '/tour.css', '/pixel.css', '/bgl.css', '/ctxmenu.css', '/ctxmenu.js', '/menu.js', '/look.js', '/fonts/PressStart2P.woff2', '/fonts/VT323.woff2', '/fonts/Figtree-400.ttf', '/fonts/Figtree-500.ttf', '/fonts/Figtree-600.ttf', '/fonts/Figtree-700.ttf', '/fonts/BowlbyOne-400.ttf', '/bridge.js', '/guide.js', '/boot.js', '/tour.js', '/music.js', '/app.js', '/mascot.png', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(KEEP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n !== KEEP).map((n) => caches.delete(n)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  // the screens: the network first (so an update shows at once), the kept copy when there is no connection
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(KEEP).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request).then((m) => m || new Response('Good Boy cannot reach the server right now. Check your connection and try again.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }))));
});
