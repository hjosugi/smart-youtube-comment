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

const assertScoringHelpers = (label, scoring) => {
  const normalized = scoring.textSignature("Ｆｏｏ　BAR!!!")
  const sameTokens = scoring.textSignature("foo bar")
  const different = scoring.textSignature("baz")

  assert.equal(
    normalized,
    sameTokens,
    `${label}: text signatures should share scoring tokenization`,
  )
  assert.equal(
    scoring.signatureDistance(normalized, sameTokens),
    0,
    `${label}: identical signatures should have zero distance`,
  )
  assert.equal(
    scoring.signatureDistance(normalized, different) > 0,
    true,
    `${label}: distinct signatures should have non-zero distance`,
  )
}

const assertDedup = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: true, simThreshold: 3, recentMax: 8 })
  overlay.canvas = makeCanvas()

  const payload = {
    text: "Hello, WORLD!!!",
    tier: 1,
    durationMs: 7500,
    score: 0.5,
    emphasis: 0.1,
    authorType: "normal",
    kind: "text",
  }

  assert.equal(overlay.push(payload), true, `${label}: first comment should be accepted`)
  assert.equal(
    overlay.push({ ...payload, text: "hello world" }),
    false,
    `${label}: normalized near-duplicate should be dropped`,
  )
  assert.equal(overlay.dropped, 1, `${label}: duplicate drop should increment dropped count`)
  assert.equal(
    overlay.pending.length - overlay.pendingHead,
    1,
    `${label}: duplicate should not enter the pending queue`,
  )
}

const loadWebOverlay = async () => {
  globalThis.self = globalThis
  globalThis.devicePixelRatio = 1
  globalThis.document = makeDocument()
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  delete globalThis.SYCScoring
  delete globalThis.SYCDanmaku

  const stamp = Date.now()
  await import(new URL(`../scoring.js?test=${stamp}`, import.meta.url))
  await import(new URL(`../danmaku.js?test=${stamp}`, import.meta.url))
  return { Overlay: globalThis.SYCDanmaku.DanmakuOverlay, scoring: globalThis.SYCScoring }
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
    readFileSync(new URL("../../extension/scoring.js", import.meta.url), "utf8"),
    sandbox,
    {
      filename: "extension/scoring.js",
    },
  )
  runInNewContext(
    readFileSync(new URL("../../extension/danmaku.js", import.meta.url), "utf8"),
    sandbox,
    {
      filename: "extension/danmaku.js",
    },
  )
  return {
    Overlay: sandbox.globalThis.SYCDanmaku.DanmakuOverlay,
    scoring: sandbox.globalThis.SYCScoring,
  }
}

const { Overlay: webOverlay, scoring: webScoring } = await loadWebOverlay()
assertScoringHelpers("web", webScoring)
assertDedup("web", webOverlay)
assertAdaptiveCap("web", webOverlay)
assertLruCache("web", webOverlay, (overlay, text) =>
  overlay._rasterize([{ t: text }], "#fff", 24, false),
)

const { Overlay: extensionOverlay, scoring: extensionScoring } = loadExtensionOverlay()
assertScoringHelpers("extension", extensionScoring)
assertDedup("extension", extensionOverlay)
assertAdaptiveCap("extension", extensionOverlay)
assertLruCache("extension", extensionOverlay, (overlay, text) =>
  overlay._rasterize(text, "#fff", 24, false),
)

console.log("danmaku ok (28 assertions)")
