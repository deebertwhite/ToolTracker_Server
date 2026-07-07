// ==========================================
// ToolTracker service worker -- app-shell resilience only
// ==========================================
// This is NOT offline-first data sync (that's a deliberately separate, future project --
// see project notes). All it does is cache the app's own static files (HTML/CSS/JS/icons)
// so the app shell still loads if the network hiccups, and so installed PWA icons open
// instantly instead of showing a blank white screen while the network round-trips.
//
// Strategy is network-first, falling back to cache only on failure: every request tries
// the real network first (so bug fixes and new features show up immediately the moment
// you're online, rather than an old cached version sticking around indefinitely -- a
// common and painful PWA mistake), and only falls back to whatever was last cached if the
// network request actually fails (genuinely offline, or the server is down).
//
// /api/* requests are explicitly never cached or intercepted -- live data must always come
// from the real server or fail honestly, never a stale cached JSON blob standing in for it.

const CACHE_NAME = 'tooltracker-shell-v1'; // bump this string whenever a cache reset is needed

const APP_SHELL_FILES = [
    '/', '/index.html', '/kiosk.html', '/admin.html', '/dashboard.html',
    '/style.css', '/kiosk.js', '/admin.js', '/dashboard.js',
    '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png',
    '/manifest-index.json', '/manifest-kiosk.json', '/manifest-admin.json', '/manifest-dashboard.json',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Never intercept API calls or non-GET requests (form posts, etc.) -- those always need
    // to hit the real server live, or fail honestly so the app's own error handling can show
    // a real "connection error" message instead of silently serving stale cached data.
    if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                const responseCopy = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseCopy));
                return networkResponse;
            })
            .catch(() => caches.match(event.request))
    );
});
