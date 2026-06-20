// Service Worker — caches the static app shell for instant load / home-screen
// launch. The live-chat API and all cross-origin requests (YouTube, the relay)
// are NEVER cached: chat must always be fresh. See ARCHITECTURE.md §8.

const CACHE = "syc-shell-v1";
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
  "./ui.js",
  "./controls.js",
  "./chat-client.js",
  "./store.js",
  "./settings.js",
  "./filter.js",
  "./scoring.js",
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
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
