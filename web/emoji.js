// Custom (member) emoji image cache. Classic script (exposes globalThis.SYCEmoji)
// so danmaku.js (also classic) can use it; ESM modules read the global too.
// Images are display-only (drawn to the danmaku canvas / shown via <img>), so no
// crossOrigin is set — avoids CORS load failures from yt3.ggpht.
;(() => {
  "use strict"
  const cache = new Map() // url -> HTMLImageElement
  const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z0-9+/=\s]+$/i

  const safeHost = host => host === "yt3.ggpht.com" || host.endsWith(".googleusercontent.com")

  const sanitizeUrl = url => {
    const text = String(url || "").trim()
    if (!text) return ""
    if (SAFE_DATA_IMAGE_RE.test(text)) return text
    try {
      const u = new URL(text)
      if (u.protocol !== "https:" || u.username || u.password || u.port) return ""
      if (!safeHost(u.hostname.toLowerCase())) return ""
      u.hash = ""
      return u.href
    } catch {
      return ""
    }
  }

  const get = url => {
    const safeUrl = sanitizeUrl(url)
    if (!safeUrl) return null
    let img = cache.get(safeUrl)
    if (!img) {
      img = new Image()
      img.decoding = "async"
      img.src = safeUrl
      cache.set(safeUrl, img)
    }
    return img
  }

  // Kick off loading a message's emoji images so they are ready when rendered.
  const preload = parts => (parts ?? []).filter(p => p.u).forEach(p => get(p.u))

  globalThis.SYCEmoji = { get, preload, sanitizeUrl }
})()
