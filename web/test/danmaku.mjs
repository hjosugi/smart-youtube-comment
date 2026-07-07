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

const makePerformanceObserver = counters =>
  class {
    constructor(callback) {
      counters.created += 1
      this.callback = callback
    }

    observe(options) {
      counters.observed += 1
      counters.lastOptions = options
      this.callback({ getEntries: () => [{}] })
    }

    disconnect() {
      counters.disconnected += 1
    }
  }

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

const assertRasterCacheInvalidation = (label, Overlay, rasterize) => {
  const overlay = new Overlay({ cacheMax: 4, dpr: 1, dedup: false })

  rasterize(overlay, "scale")
  assert.equal(overlay.cache.size, 1, `${label}: first bitmap should be cached`)

  overlay.setConfig({ dpr: 2 })
  assert.equal(overlay.cache.size, 0, `${label}: dpr changes should clear cached bitmaps`)

  rasterize(overlay, "scale")
  assert.equal(overlay.cache.size, 1, `${label}: new dpr bitmap should be cached`)

  overlay.setConfig({ dpr: 2 })
  assert.equal(overlay.cache.size, 1, `${label}: unchanged dpr should keep cached bitmaps`)

  overlay.setConfig({ maxActive: 300 })
  assert.equal(overlay.cache.size, 1, `${label}: non-raster settings should keep cached bitmaps`)

  overlay.setConfig({ fontFamily: "serif" })
  assert.equal(overlay.cache.size, 0, `${label}: font changes should clear cached bitmaps`)

  rasterize(overlay, "scale")
  assert.equal(overlay.cache.size, 1, `${label}: changed font bitmap should be cached`)

  overlay.setConfig({ lineHeight: 36 })
  assert.equal(overlay.cache.size, 0, `${label}: geometry changes should clear cached bitmaps`)
}

const assertResizeGating = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, lineHeight: 24, topPct: 0.08, bottomPct: 0.14 })
  overlay.canvas = makeCanvas()
  overlay.player = { getBoundingClientRect: () => ({ width: 320, height: 180 }) }
  let resizes = 0
  overlay._resize = () => {
    resizes += 1
  }

  overlay.setConfig({ opacity: 0.5 })
  assert.equal(resizes, 0, `${label}: visual-only changes should not resize canvas`)

  overlay.setConfig({ maxActive: 300 })
  assert.equal(resizes, 0, `${label}: throughput-only changes should not resize canvas`)

  overlay.setConfig({ lineHeight: 32 })
  assert.equal(resizes, 1, `${label}: lane geometry changes should resize canvas`)

  overlay.setConfig({ dpr: 1.5 })
  assert.equal(resizes, 2, `${label}: dpr changes should resize canvas`)
}

const payload = (text, overrides = {}) => ({
  text,
  parts: [{ t: text }],
  tier: 1,
  durationMs: 7500,
  score: 0,
  emphasis: 0,
  authorType: "normal",
  kind: "text",
  ...overrides,
})

const assertPriorityQueueAdmission = (label, Overlay) => {
  const overlay = new Overlay({ maxQueue: 2, dpr: 1, dedup: false })
  overlay.canvas = makeCanvas()

  assert.equal(overlay.push(payload("low")), true, `${label}: first pending comment accepted`)
  assert.equal(
    overlay.push(payload("mid", { score: 0.5 })),
    true,
    `${label}: second pending comment accepted`,
  )
  assert.equal(
    overlay.push(payload("weaker")),
    false,
    `${label}: weaker comment should drop when pending queue is full`,
  )
  assert.equal(overlay.dropped, 1, `${label}: dropped count should include rejected pending item`)
  assert.equal(
    overlay.push(payload("paid", { kind: "paid", score: 1 })),
    true,
    `${label}: higher-priority comment should evict the weakest pending item`,
  )

  const pendingTexts = overlay.pending.map(item => item.payload.text).sort()
  assert.equal(
    JSON.stringify(pendingTexts),
    JSON.stringify(["mid", "paid"]),
    `${label}: pending queue should retain strongest`,
  )
}

const assertActiveCapEviction = (label, Overlay) => {
  const overlay = new Overlay({
    maxActive: 2,
    minActive: 2,
    dpr: 1,
    dedup: false,
    lengthSpread: false,
  })
  overlay.canvas = makeCanvas()
  overlay.ctx = makeContext()
  overlay.w = 320
  overlay.h = 180
  overlay.laneTop = 0
  overlay.laneH = 24
  overlay.laneCount = 3
  overlay.lanes = [0, 0, 0]
  overlay.dynamicCap = 2

  assert.equal(overlay._spawn(payload("low"), 0.1), true, `${label}: first active spawn accepted`)
  assert.equal(overlay._spawn(payload("mid"), 0.2), true, `${label}: second active spawn accepted`)
  assert.equal(
    overlay._spawn(payload("weak"), 0.05),
    false,
    `${label}: weaker active candidate should drop at cap`,
  )
  assert.equal(overlay.dropped, 1, `${label}: dropped count should include rejected active item`)
  assert.equal(
    overlay._spawn(payload("high"), 0.9),
    true,
    `${label}: stronger active candidate should evict weakest active item`,
  )
  assert.equal(overlay.active.length, 2, `${label}: active set should stay capped`)
  const activePriorities = overlay.active.map(item => item.priority).sort((a, b) => a - b)
  assert.equal(
    JSON.stringify(activePriorities),
    JSON.stringify([0.2, 0.9]),
    `${label}: active set should retain strongest priorities`,
  )
}

const assertLaneSelectionAndClear = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: false })
  overlay.laneCount = 3
  overlay.lanes = [200, 150, 170]
  assert.equal(overlay._pickLane(100), 1, `${label}: all-busy lanes choose soonest free lane`)
  assert.equal(overlay._pickLane(151), 1, `${label}: already-free lane is reused immediately`)

  if (typeof overlay.clear === "function") {
    overlay.active.push({ priority: 1 })
    overlay.nextActive.push({ priority: 2 })
    overlay.pending.push({ payload: payload("queued"), priority: 1 })
    overlay.pendingHead = 1
    overlay.recentLen = 3
    overlay.recentPos = 2
    overlay.clear()

    assert.equal(overlay.active.length, 0, `${label}: clear removes active comments`)
    assert.equal(overlay.nextActive.length, 0, `${label}: clear removes next-active comments`)
    assert.equal(overlay.pending.length, 0, `${label}: clear removes pending comments`)
    assert.equal(overlay.pendingHead, 0, `${label}: clear resets pending head`)
    assert.equal(overlay.recentLen, 0, `${label}: clear resets dedup recent length`)
    assert.equal(overlay.recentPos, 0, `${label}: clear resets dedup ring position`)
  }
}

const assertPendingCompaction = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: false })
  overlay.pending = Array.from({ length: 520 }, (_, i) => ({
    payload: payload(`p${i}`),
    priority: i,
  }))
  overlay.pendingHead = 260
  overlay._compactPending()
  assert.equal(overlay.pending.length, 260, `${label}: compact removes consumed prefix`)
  assert.equal(overlay.pendingHead, 0, `${label}: compact resets pending head`)
  assert.equal(
    overlay.pending[0].payload.text,
    "p260",
    `${label}: compact keeps first unconsumed item`,
  )

  overlay.pendingHead = overlay.pending.length
  overlay._compactPending()
  assert.equal(overlay.pending.length, 0, `${label}: compact clears fully consumed queue`)
  assert.equal(overlay.pendingHead, 0, `${label}: compact resets fully consumed head`)
}

const assertRendererDefaultsMatchSettings = (label, rendererDefaults, settings) => {
  const engineDefaults = settings.toEngineConfig(settings.DEFAULTS)
  const rendererEngineDefaults = Object.fromEntries(
    Object.keys(engineDefaults).map(key => [key, rendererDefaults[key]]),
  )

  assert.equal(
    JSON.stringify(rendererEngineDefaults),
    JSON.stringify(engineDefaults),
    `${label}: renderer DEFAULTS should match settings-derived engine defaults`,
  )
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

  const samplePayload = {
    text: "Hello, WORLD!!!",
    tier: 1,
    durationMs: 7500,
    score: 0.5,
    emphasis: 0.1,
    authorType: "normal",
    kind: "text",
  }

  assert.equal(overlay.push(samplePayload), true, `${label}: first comment should be accepted`)
  assert.equal(
    overlay.push({ ...samplePayload, text: "hello world" }),
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

const assertLongTaskObserverLifecycle = (label, Overlay, counters) => {
  const overlay = new Overlay({ dpr: 1, dedup: false })

  assert.equal(counters.observed, 0, `${label}: constructor should not subscribe before attach`)
  overlay._startLongTaskObserver()
  assert.equal(counters.observed, 1, `${label}: observer should subscribe on start`)
  assert.equal(overlay.longTasks, 1, `${label}: observer callback should update long-task count`)
  overlay._startLongTaskObserver()
  assert.equal(counters.observed, 1, `${label}: repeated start should not double subscribe`)

  overlay.detach()
  assert.equal(counters.disconnected, 1, `${label}: detach should disconnect the observer`)
  assert.equal(overlay._lto, null, `${label}: detach should clear the observer handle`)

  overlay._startLongTaskObserver()
  assert.equal(counters.observed, 2, `${label}: observer should be restartable after detach`)
  overlay._stopLongTaskObserver()
  assert.equal(
    counters.disconnected,
    2,
    `${label}: explicit stop should disconnect restarted observer`,
  )
}

const loadWebOverlay = async () => {
  const observerCounters = { created: 0, observed: 0, disconnected: 0, lastOptions: null }
  globalThis.self = globalThis
  globalThis.devicePixelRatio = 1
  globalThis.document = makeDocument()
  globalThis.PerformanceObserver = makePerformanceObserver(observerCounters)
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  delete globalThis.SYCScoring
  delete globalThis.SYCSettings
  delete globalThis.SYCDanmaku

  const stamp = Date.now()
  await import(new URL(`../scoring.js?test=${stamp}`, import.meta.url))
  await import(new URL(`../settings.js?test=${stamp}`, import.meta.url))
  await import(new URL(`../danmaku.js?test=${stamp}`, import.meta.url))
  return {
    Overlay: globalThis.SYCDanmaku.DanmakuOverlay,
    defaults: globalThis.SYCDanmaku.DEFAULTS,
    observerCounters,
    scoring: globalThis.SYCScoring,
    settings: globalThis.SYCSettings,
  }
}

const loadExtensionOverlay = () => {
  const observerCounters = { created: 0, observed: 0, disconnected: 0, lastOptions: null }
  const sandbox = {
    cancelAnimationFrame() {},
    console,
    devicePixelRatio: 1,
    document: makeDocument(),
    globalThis: null,
    performance: { now: () => 1000 },
    PerformanceObserver: makePerformanceObserver(observerCounters),
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
    readFileSync(new URL("../../extension/settings.js", import.meta.url), "utf8"),
    sandbox,
    {
      filename: "extension/settings.js",
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
    defaults: sandbox.globalThis.SYCDanmaku.DEFAULTS,
    observerCounters,
    scoring: sandbox.globalThis.SYCScoring,
    settings: sandbox.globalThis.SYCSettings,
  }
}

const {
  Overlay: webOverlay,
  defaults: webDefaults,
  observerCounters: webObserverCounters,
  scoring: webScoring,
  settings: webSettings,
} = await loadWebOverlay()
assertRendererDefaultsMatchSettings("web", webDefaults, webSettings)
assertScoringHelpers("web", webScoring)
assertDedup("web", webOverlay)
assertLongTaskObserverLifecycle("web", webOverlay, webObserverCounters)
assertAdaptiveCap("web", webOverlay)
assertLruCache("web", webOverlay, (overlay, text) =>
  overlay._rasterize([{ t: text }], "#fff", 24, false),
)
assertRasterCacheInvalidation("web", webOverlay, (overlay, text) =>
  overlay._rasterize([{ t: text }], "#fff", 24, false),
)
assertResizeGating("web", webOverlay)
assertPriorityQueueAdmission("web", webOverlay)
assertActiveCapEviction("web", webOverlay)
assertLaneSelectionAndClear("web", webOverlay)
assertPendingCompaction("web", webOverlay)

const {
  Overlay: extensionOverlay,
  defaults: extensionDefaults,
  observerCounters: extensionObserverCounters,
  scoring: extensionScoring,
  settings: extensionSettings,
} = loadExtensionOverlay()
assertRendererDefaultsMatchSettings("extension", extensionDefaults, extensionSettings)
assertScoringHelpers("extension", extensionScoring)
assertDedup("extension", extensionOverlay)
assertLongTaskObserverLifecycle("extension", extensionOverlay, extensionObserverCounters)
assertAdaptiveCap("extension", extensionOverlay)
assertLruCache("extension", extensionOverlay, (overlay, text) =>
  overlay._rasterize(text, "#fff", 24, false),
)
assertRasterCacheInvalidation("extension", extensionOverlay, (overlay, text) =>
  overlay._rasterize(text, "#fff", 24, false),
)
assertResizeGating("extension", extensionOverlay)
assertPriorityQueueAdmission("extension", extensionOverlay)
assertActiveCapEviction("extension", extensionOverlay)
assertLaneSelectionAndClear("extension", extensionOverlay)
assertPendingCompaction("extension", extensionOverlay)

console.log("danmaku ok (106 assertions)")
