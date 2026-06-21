// Custom (member) emoji image cache. Classic script (exposes globalThis.SYCEmoji)
// so danmaku.js (also classic) can use it; ESM modules read the global too.
// Images are display-only (drawn to the danmaku canvas / shown via <img>), so no
// crossOrigin is set — avoids CORS load failures from yt3.ggpht.
;(() => {
  "use strict"
  const cache = new Map() // url -> HTMLImageElement

  const get = url => {
    let img = cache.get(url)
    if (!img) {
      img = new Image()
      img.decoding = "async"
      img.src = url
      cache.set(url, img)
    }
    return img
  }

  // Kick off loading a message's emoji images so they are ready when rendered.
  const preload = parts => (parts ?? []).filter(p => p.u).forEach(p => get(p.u))

  globalThis.SYCEmoji = { get, preload }
})()
