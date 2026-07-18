# WDP — Offline / PWA Support

This document covers the PWA conversion done in three phases: app manifest +
icons, service worker, and this write-up. It's meant to be committed
alongside the app files so the setup is explainable later, not just working.

## 1. Files added

| File | Purpose |
|---|---|
| `manifest.json` | Web app manifest — name, icons, colors, standalone display mode. Makes "Add to Home Screen" / desktop install available. |
| `icons/icon-192.png` | 192×192 app icon, extracted 1:1 from the existing embedded logo (no quality loss). |
| `icons/icon-512.png` | 512×512 app icon, upscaled from the same 192×192 source (see Limitations — no higher-resolution source logo was available). |
| `service-worker.js` | Caches the app shell, fonts, and local brand-logo assets; serves them without a network round trip once cached. |

## 2. Files modified

**None.** `index.html` already contained `<link rel="manifest" href="manifest.json">`,
the `apple-touch-icon`/`apple-mobile-web-app-*` meta tags, the
`navigator.serviceWorker.register('service-worker.js')` call, and the
online/offline toast logic. That code was written against files that didn't
exist yet — this phase just supplies them. No line of `index.html` needed to
change.

## 3. How offline mode works

WDP has no backend API. Every module (Finance, Workers, Contractors,
Suppliers, Warehouse, Timeline, Site Diary, Savings) reads and writes
directly to `localStorage` (much of it AES-GCM encrypted) with no server
round trip in the write path. That means **CRUD already works offline by
construction** — nothing in this phase changes how data is created, read,
updated, or deleted.

What was actually missing for a *full* offline experience was everything
around that data layer:

- **The app shell** (`index.html` itself, ~3 MB) — without a service worker,
  a browser with no signal simply can't fetch it, so the app couldn't even
  open offline before this phase.
- **Google Fonts** — loaded from `fonts.googleapis.com` / `fonts.gstatic.com`;
  uncached, these block/degrade the UI offline.
- **Local brand-logo SVGs** (`assets/brands/*.svg`) — static site assets used
  by the bank/company branding UI.
- **Installability** — no manifest meant no real "Add to Home Screen" /
  standalone window.

The service worker (`service-worker.js`) closes these gaps with one strategy
per resource type:

| Resource | Strategy | Behavior |
|---|---|---|
| `index.html` (any navigation) | Cache-First, single key | Every navigation resolves to the one precached shell — there's no client-side router, so this is correct for every URL the app is opened at. |
| `manifest.json`, icons | Cache-First | Same lifecycle as the shell. |
| Google Fonts | Stale-While-Revalidate | Instant from cache; refreshed in the background when online. |
| `assets/brands/*.svg` | Cache-First, filled in progressively | Each logo is cached the first time it's *seen while online*; after that it loads instantly, online or off. |
| `open.er-api.com` (FX rates) | Network-First, cache fallback | A second, independent safety net on top of the app's own existing localStorage-level FX fallback. |
| Any `POST` request (this includes every call to `AI_PROXY_URL`) | Not intercepted at all | The Cache API can't store `POST` responses, and these calls (AI report generation) must never be served stale — they're excluded before any routing logic runs, so this holds even if `AI_PROXY_URL` changes later. |

## 4. How "synchronization" works here

There are no pending mutations to replay, because there's no backend to
replay them to — offline writes are just normal `localStorage` writes, already
durable the moment they happen. The only thing that "syncs" on reconnect is
the FX exchange rate: the existing `online` event listener in `index.html`
already calls `fxEnsureRates()` when connectivity returns, and the service
worker's FX cache backs that up independently.

## 5. Cache versioning

`service-worker.js` opens caches named `wdp-shell-v1`, `wdp-fonts-v1`,
`wdp-brands-v1`, `wdp-fx-v1` (the `v1` comes from the `CACHE_VERSION` constant
at the top of the file). On `activate`, any cache starting with `wdp-` that
isn't in the current version's list is deleted automatically.

**To ship an update to `index.html`, `manifest.json`, or the icons:** bump
`CACHE_VERSION` (e.g. `'v1'` → `'v2'`) in `service-worker.js` and redeploy.
That single-character change is what makes the browser notice the SW file
changed, re-run `install`, fetch the new shell, and drop the old cache on
`activate`. Without a version bump, returning visitors keep the old cached
shell indefinitely — this is intentional (deterministic, no partial/mixed
content), not an oversight.

## 6. How to test

1. **First load, online.** Deploy `manifest.json`, `icons/`, and
   `service-worker.js` next to `index.html`. Open the site. Check DevTools →
   Application → Service Workers (should show "activated and running") and
   → Manifest (no errors, icons render).
2. **Install as PWA.** Chrome/Edge: address-bar install icon or menu → "Install
   WDP Finance". iOS Safari: Share → "Add to Home Screen". Launch it — it
   should open in a standalone window/full screen, no browser chrome.
3. **Reload offline.** DevTools → Network → "Offline" (or real airplane
   mode), then hard-refresh. The app should open normally, not show the
   browser's own offline error page.
4. **Offline navigation.** Move between modules (Finance, Workers, Timeline,
   etc.) while offline — all client-side, should behave identically to
   online.
5. **Offline CRUD.** While offline: add a transaction, edit a worker record,
   delete a Site Diary entry. Reload while still offline — changes should
   still be there (this is just `localStorage`, but worth confirming
   nothing in this phase interferes with it).
6. **Cache invalidation.** Change something trivial in `index.html`, bump
   `CACHE_VERSION` in `service-worker.js`, redeploy, reload the already-open
   app. You should see the "✓ Update ready — refresh to apply" toast; a
   manual refresh after that should load the new content.
7. **Multiple refreshes while offline.** Refresh 3–4 times consecutively
   while offline — each should load instantly from cache, no flicker to a
   browser error page.

## 7. Limitations

- **First visit must be online once.** There's no way to install the app
  shell into the cache without at least one successful network fetch.
- **512×512 icon is a digital upscale** of the only source available
  (192×192) — replace `icons/icon-512.png` if a higher-resolution logo
  becomes available later.
- **Brand logos** (`assets/brands/*.svg`) are cached individually the first
  time each one is *rendered while online*. A company/bank logo the user has
  never seen while connected will show its fallback (initials/icon) badge
  the first time it's needed offline, not the real logo.
- **AI-generated reports** (`AI_PROXY_URL` calls) require network by design —
  they're never cached, since caching a generative response would mean
  showing stale/wrong AI output.
- **FX exchange rates** can only update when online; offline, the app shows
  the last known rate (already labeled "Approximate rates (offline)" in the
  existing UI).
