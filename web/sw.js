// Service Worker — caches the built app shell for instant load / home-screen
// launch. The live-chat API and all cross-origin requests (YouTube, the relay)
// are NEVER cached: chat must always be fresh. See ARCHITECTURE.md §8.
// (web/dist is the deployed output: app.js is the bundled module graph; the rest
// are script globals, shared helpers, and static assets.)

const CACHE = "syc-shell-v4"
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./math.js",
  "./theme.js",
  "./store.js",
  "./settings.js",
  "./filter.js",
  "./scoring.js",
  "./emoji.js",
  "./danmaku.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
]
const SHELL_PATHS = new Set(SHELL.map(path => new URL(path, self.location.href).pathname))

self.addEventListener("install", e => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", e => {
  e.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url)
  // Only the same-origin static shell is cacheable. Chat API + YouTube + relay
  // are always live (pass through to the network).
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return
  if (url.pathname.includes("/api/livechat")) return
  if (!SHELL_PATHS.has(url.pathname)) return

  const cacheKey = new URL(url.pathname, self.location.origin).href
  // Stale-while-revalidate: serve cache instantly, refresh in the background so a
  // new deploy is picked up on the next load.
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(cacheKey)
      const fresh = fetch(e.request)
        .then(res => {
          if (res.ok) cache.put(cacheKey, res.clone())
          return res
        })
        .catch(() => cached)
      return cached || fresh
    }),
  )
})
