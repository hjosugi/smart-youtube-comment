import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const makeContext = () => ({
  clearRect() {},
  drawImage() {},
  fillText() {},
  measureText(text) {
    return { width: String(text).length * 10 }
  },
  scale() {},
  setTransform() {},
  strokeText() {},
})

const makeCanvas = () => ({
  height: 0,
  width: 0,
  getContext() {
    return makeContext()
  },
})

const makeDocument = () => ({
  createElement(tag) {
    assert.equal(tag, "canvas")
    return makeCanvas()
  },
})

const hasCacheText = (cache, text) => Array.from(cache.keys()).some(key => key.endsWith(`|${text}`))

const assertAdaptiveCap = (label, Overlay) => {
  const overlay = new Overlay({ maxActive: 100, minActive: 25, dpr: 1, dedup: false })
  overlay.ctx = makeContext()
  overlay.running = true

  overlay.frameEMA = 50
  overlay.lastTs = 1000
  overlay._loop(1050)
  assert.equal(overlay.dynamicCap, 25, `${label}: slow frames should clamp to minActive`)

  overlay.frameEMA = 16
  overlay.lastTs = 2000
  overlay._loop(2016)
  assert.equal(overlay.dynamicCap, 100, `${label}: fast frames should recover to maxActive`)
}

const assertLruCache = (label, Overlay, rasterize) => {
  const overlay = new Overlay({ cacheMax: 2, dpr: 1, dedup: false })

  const firstAlpha = rasterize(overlay, "alpha")
  rasterize(overlay, "beta")
  const secondAlpha = rasterize(overlay, "alpha")
  assert.equal(secondAlpha, firstAlpha, `${label}: cache hits should reuse existing bitmap entry`)

  rasterize(overlay, "gamma")
  assert.equal(overlay.cache.size, 2, `${label}: cache should stay capped`)
  assert.equal(
    hasCacheText(overlay.cache, "alpha"),
    true,
    `${label}: recent hit should be retained`,
  )
  assert.equal(
    hasCacheText(overlay.cache, "beta"),
    false,
    `${label}: least recent bitmap should be evicted`,
  )
  assert.equal(hasCacheText(overlay.cache, "gamma"), true, `${label}: new bitmap should be cached`)
}

const loadWebOverlay = async () => {
  globalThis.self = globalThis
  globalThis.devicePixelRatio = 1
  globalThis.document = makeDocument()
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  delete globalThis.SYCDanmaku

  await import(new URL(`../danmaku.js?test=${Date.now()}`, import.meta.url))
  return globalThis.SYCDanmaku.DanmakuOverlay
}

const loadExtensionOverlay = () => {
  const sandbox = {
    cancelAnimationFrame() {},
    console,
    devicePixelRatio: 1,
    document: makeDocument(),
    globalThis: null,
    requestAnimationFrame: () => 1,
    self: null,
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  runInNewContext(
    readFileSync(new URL("../../extension/danmaku.js", import.meta.url), "utf8"),
    sandbox,
    {
      filename: "extension/danmaku.js",
    },
  )
  return sandbox.globalThis.SYCDanmaku.DanmakuOverlay
}

const webOverlay = await loadWebOverlay()
assertAdaptiveCap("web", webOverlay)
assertLruCache("web", webOverlay, (overlay, text) =>
  overlay._rasterize([{ t: text }], "#fff", 24, false),
)

const extensionOverlay = loadExtensionOverlay()
assertAdaptiveCap("extension", extensionOverlay)
assertLruCache("extension", extensionOverlay, (overlay, text) =>
  overlay._rasterize(text, "#fff", 24, false),
)

console.log("danmaku ok (14 assertions)")
