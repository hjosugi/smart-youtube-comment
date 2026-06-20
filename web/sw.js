// Service Worker — caches the static app shell for instant load / home-screen
// launch. The live-chat API and all cross-origin requests (YouTube, the relay)
// are NEVER cached: chat must always be fresh. See ARCHITECTURE.md §8.

const CACHE = "syc-shell-v2";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./pipeline.js",
  "./player.js",
  "./mock.js",
  "./lifecycle.js",
  "./perf.js",
  "./playback.js",
  "./videoctl.js",
  "./commentlist.js",
  "./ui.js",
  "./controls.js",
  "./chat-client.js",
  "./store.js",
  "./settings.js",
  "./filter.js",
  "./scoring.js",
  "./emoji.js",
  "./danmaku.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only the same-origin static shell is cacheable. Chat API + YouTube + relay
  // are always live (pass through to the network).
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/livechat")) return;
  // Stale-while-revalidate: serve cache instantly, refresh in the background so a
  // new deploy is picked up on the next load (no manual cache-busting needed).
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
