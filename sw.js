// ── ExpRE Service Worker ──────────────────────────────────────────────────────
// Caching strategies:
//   HTML shell       → Network First, cache fallback
//   Campaign API     → Network First, cache fallback
//   AR libraries     → Cache First (large versioned CDN files)
//   Videos / camera  → Network Only
//
// ?id= tracking:
//   The page sends the current ?id= param via postMessage on every load.
//   SW stores it in a tiny metadata cache entry ('expre-last-id').
//   The page reads it back via a custom /sw-meta/last-id fetch to build
//   the manifest blob with the correct start_url for the installed PWA icon.

const CACHE_VERSION = 'expre-v3';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const LIB_CACHE     = `${CACHE_VERSION}-libs`;
const META_CACHE    = `${CACHE_VERSION}-meta`;   // stores last-seen ?id=

const SHELL_FILES = [
    './index.html',
    './offline.html'
];

const LIB_URLS = [
    'https://aframe.io/releases/1.6.0/aframe.min.js',
    'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-aframe.prod.js'
];

const API_ORIGIN = 'https://akm-img-a-in.tosshub.com';

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const shellCache = await caches.open(SHELL_CACHE);
        await Promise.allSettled(
            SHELL_FILES.map(url =>
                fetch(url, { cache: 'reload' })
                    .then(res => { if (res.ok) shellCache.put(url, res); })
                    .catch(err => console.warn('[SW] Could not cache', url, err))
            )
        );
        // Libraries: best-effort, don't block install
        caches.open(LIB_CACHE).then(c =>
            Promise.allSettled(LIB_URLS.map(u => c.add(u)))
        );
        await self.skipWaiting();
    })());
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const valid = [SHELL_CACHE, API_CACHE, LIB_CACHE, META_CACHE];
        const keys  = await caches.keys();
        await Promise.all(keys.filter(k => !valid.includes(k)).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

// ── Message: page → SW ───────────────────────────────────────────────────────
// Page sends { type: 'UPDATE_ID', id: '...', fullUrl: '...' } on every load.
// SW persists it so the manifest start_url stays up to date.
self.addEventListener('message', async event => {
    if (event.data?.type !== 'UPDATE_ID') return;

    const { id, fullUrl } = event.data;
    const meta = { id, fullUrl, updatedAt: Date.now() };

    const cache = await caches.open(META_CACHE);
    // Store as a synthetic Response so we can retrieve it via cache.match()
    await cache.put(
        'expre-last-id',
        new Response(JSON.stringify(meta), {
            headers: { 'Content-Type': 'application/json' }
        })
    );
    console.log('[SW] Updated last-id:', id, fullUrl);
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Internal meta endpoint — page fetches this to read back the stored id/url
    if (url.pathname.endsWith('/sw-meta/last-id')) {
        event.respondWith(getLastId());
        return;
    }

    // AR libraries → Cache First
    if (LIB_URLS.some(u => request.url.startsWith(u))) {
        event.respondWith(cacheFirst(request, LIB_CACHE));
        return;
    }

    // Campaign API → Network First
    if (url.origin === API_ORIGIN) {
        event.respondWith(networkFirst(request, API_CACHE));
        return;
    }

    // HTML navigation → Network First with offline fallback
    if (request.mode === 'navigate' ||
        url.pathname.endsWith('.html') ||
        url.pathname.endsWith('manifest.json')) {
        event.respondWith(networkFirstWithOfflineFallback(request));
        return;
    }

    // Everything else → Network Only
});

// ── Read last stored id/url ───────────────────────────────────────────────────
async function getLastId() {
    const cache  = await caches.open(META_CACHE);
    const cached = await cache.match('expre-last-id');
    if (cached) return cached.clone();
    return new Response(JSON.stringify({ id: null, fullUrl: null }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

// ── Strategy: Network First, cache fallback ───────────────────────────────────
async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }
}

// ── Strategy: Network First, offline.html fallback ───────────────────────────
async function networkFirstWithOfflineFallback(request) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch {
        const cached = await cache.match(request)
                    || await cache.match('./index.html')
                    || await cache.match('./ar-experience.html');
        if (cached) return cached;
        const offline = await cache.match('./offline.html');
        return offline || new Response('<h1>Offline</h1>', {
            headers: { 'Content-Type': 'text/html' }
        });
    }
}

// ── Strategy: Cache First, network fallback ───────────────────────────────────
async function cacheFirst(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch {
        return new Response('Network error', { status: 503 });
    }
}
