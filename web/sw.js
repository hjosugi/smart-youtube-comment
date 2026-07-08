// Service Worker — caches the built app shell for instant load / home-screen
// launch. The live-chat API and all cross-origin requests (YouTube, the relay)
// are NEVER cached: chat must always be fresh. See ARCHITECTURE.md §8.
// (web/dist is the deployed output: app.js is the bundled module graph; the rest
// are script globals, shared helpers, and static assets.)

/** @type {ServiceWorkerGlobalScope & typeof globalThis} */
const sw = /** @type {ServiceWorkerGlobalScope & typeof globalThis} */ (
  /** @type {unknown} */ (self)
)

const CACHE = "syc-shell-__SYC_SHELL_VERSION__"
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
      .then(() => sw.skipWaiting()),
  )
})

self.addEventListener("activate", e => {
  e.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => sw.clients.claim()),
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
  // Cache-first by build-stamped shell version. The build replaces CACHE with a
  // hash of the complete shell, so one cache never mixes files from two deploys.
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(cacheKey)
      if (cached) return cached
      const fresh = await fetch(e.request)
      if (fresh.ok) await cache.put(cacheKey, fresh.clone())
      return fresh
    }),
  )
})
