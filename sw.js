/* FF Cash Battle service worker
   1) shows message notifications and opens the right chat when tapped
   2) caches the VERSIONED js/css (?v=hash) cache-first and images stale-while-revalidate -> repeat visits are instant.
   index.html and html pages are never cached here, so a new deploy is picked up immediately. */
const STATIC = 'ffcb-static-138b436893';   // build.py replaces this with the build hash
const ASSETS = 'ffcb-assets';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
    for (const k of await caches.keys()) { if (k.startsWith('ffcb-static-') && k !== STATIC) await caches.delete(k); }
    await self.clients.claim();
})()));

const ASSET_PATH = new URL('assets/', self.registration.scope).pathname;
self.addEventListener('fetch', (e) => {
    const r = e.request;
    if (r.method !== 'GET' || r.headers.has('range')) return;
    const u = new URL(r.url);
    if (u.origin !== location.origin) return;
    const versioned = /\.(js|css)$/.test(u.pathname) && u.searchParams.has('v');
    const asset = u.pathname.startsWith(ASSET_PATH);
    if (!versioned && !asset) return;
    e.respondWith((async () => {
        const c = await caches.open(versioned ? STATIC : ASSETS);
        const hit = await c.match(r);
        if (versioned) {                       // the file name carries its hash -> a cached copy is always correct
            if (hit) return hit;
            const res = await fetch(r);
            if (res.status === 200) c.put(r, res.clone()).catch(() => {});
            return res;
        }
        const net = fetch(r).then((res) => { if (res.status === 200) c.put(r, res.clone()).catch(() => {}); return res; });
        if (hit) { net.catch(() => {}); return hit; }
        return net;
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const d = event.notification.data || {};
    const url = new URL(d.kind ? './?chat=' + encodeURIComponent(d.kind + ':' + d.id) : './', self.registration.scope).href;
    event.waitUntil((async () => {
        const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of list) {
            if ('focus' in c) { c.postMessage({ type: 'open-chat', room: d }); return c.focus(); }
        }
        return self.clients.openWindow(url);
    })());
});

// Ready for real push later (FCM / Web Push): shows whatever the server sends.
self.addEventListener('push', (event) => {
    let p = {}; try { p = event.data ? event.data.json() : {}; } catch (e) { p = { title: 'FF Cash Battle', body: event.data ? event.data.text() : '' }; }
    event.waitUntil(self.registration.showNotification(p.title || 'FF Cash Battle', { body: p.body || '', icon: 'assets/icons/icon-192.png', badge: 'assets/icons/icon-192.png', tag: p.tag, data: p.data || {} }));
});
