// ════════════════════════════════════════════════════════════════════════
//  WDP — Service Worker
// ────────────────────────────────────────────────────────────────────────
//  WDP has no backend API — all app data lives in localStorage on-device,
//  so offline CRUD already works without this file. This service worker's
//  only job is: (1) let the browser install WDP as an app, and (2) make the
//  app shell (index.html), fonts, and local brand-logo assets load instantly
//  and work with zero network — even on first offline visit after one
//  successful online load.
//
//  ── Deploying an update ──────────────────────────────────────────────
//  Bump CACHE_VERSION below on every deploy that changes index.html,
//  manifest.json, or the icons. That's what makes the browser notice this
//  file changed, re-run install, fetch the new shell, and (on activate)
//  delete the previous version's caches. Without a version bump, returning
//  visitors keep seeing the old cached shell indefinitely.
// ════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'v1';

const SHELL_CACHE  = `wdp-shell-${CACHE_VERSION}`;
const FONTS_CACHE  = `wdp-fonts-${CACHE_VERSION}`;
const BRANDS_CACHE = `wdp-brands-${CACHE_VERSION}`;
const FX_CACHE      = `wdp-fx-${CACHE_VERSION}`;

// Any existing cache whose name isn't in this list gets deleted on activate.
const EXPECTED_CACHES = [SHELL_CACHE, FONTS_CACHE, BRANDS_CACHE, FX_CACHE];

// Precached at install time. './' is the canonical key every navigation
// resolves to (see cacheFirstShell) — WDP is a single-page app with no
// client-side router, so every navigation should get the same document.
const SHELL_PRECACHE_URLS = [
  './',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Same set, minus './', used to route plain (non-navigate) requests for
// manifest/icons to the shell cache. Kept separate from the list above so
// the generic pathname match below can't accidentally catch every request
// ending in '/'.
const SHELL_ASSET_URLS = SHELL_PRECACHE_URLS.filter(u => u !== './');

const FONT_HOSTS  = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const FX_API_HOST = 'open.er-api.com';
const BRANDS_PATH = '/assets/brands/';

// ── INSTALL — precache the shell, then activate immediately ──────────────
// skipWaiting() is safe here: index.html already shows an "update ready —
// refresh to apply" toast on the 'installed' statechange event, and that
// event still fires before activation whether or not skipWaiting is called.
// Calling it just means the *next* manual refresh the user does actually
// picks up the new version, instead of staying stuck on the old one.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE — drop every cache from a previous version ──────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(name => name.startsWith('wdp-') && !EXPECTED_CACHES.includes(name))
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH — route each request to a caching strategy ──────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;

  // Never touch non-GET requests. This is what keeps the AI-report proxy
  // (AI_PROXY_URL, all POST) and any other mutation always hitting the
  // network live — the Cache API can't store POST responses anyway, and
  // these calls should never be served stale.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 1) Navigations — always the cached app shell, instantly.
  if (req.mode === 'navigate') {
    event.respondWith(cacheFirstShell(req));
    return;
  }

  // 2) manifest.json / icons — part of the shell, same version lifecycle.
  if (url.origin === self.location.origin &&
      SHELL_ASSET_URLS.some(u => url.pathname.endsWith(u.replace('./', '/')))) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // 3) Google Fonts — stale-while-revalidate: instant from cache, refreshed
  //    in the background so we're never stuck on a broken/old font forever.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, FONTS_CACHE));
    return;
  }

  // 4) Local brand-logo SVGs (assets/brands/*.svg) — cache-first, filling
  //    in progressively as each logo is first seen. Safe to cache
  //    aggressively since these are static site assets, not user data.
  if (url.origin === self.location.origin && url.pathname.includes(BRANDS_PATH)) {
    event.respondWith(cacheFirst(req, BRANDS_CACHE));
    return;
  }

  // 5) FX rate API — network-first, falling back to the last good rate
  //    when offline. (The app itself already has its own localStorage-level
  //    fallback for this; this is a second, independent safety net.)
  if (url.hostname === FX_API_HOST) {
    event.respondWith(networkFirst(req, FX_CACHE));
    return;
  }

  // 6) Anything else (unrecognized same- or cross-origin GET) — best-effort
  //    network-first with a cache fallback if we happen to have one from a
  //    previous visit; otherwise it fails through normally.
  event.respondWith(networkFirst(req, SHELL_CACHE));
});

// ── Strategies ─────────────────────────────────────────────────────────

// Always resolve navigations to the single precached shell document,
// regardless of the exact URL requested — this is a single-page app.
async function cacheFirstShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match('./');
  if (cached) return cached;
  // Nothing cached yet (first-ever load must have failed) — try the network
  // as a last resort; if that fails too, let the browser show its own
  // offline page this one time only.
  const res = await fetch(req);
  if (res && res.ok) cache.put('./', res.clone());
  return res;
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  if (cached) {
    // Update the cache in the background; don't make the caller wait for it.
    networkPromise.catch(() => {});
    return cached;
  }
  const fromNetwork = await networkPromise;
  if (fromNetwork) return fromNetwork;
  return Response.error();
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}
