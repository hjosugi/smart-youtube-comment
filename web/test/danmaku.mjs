import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const makeContext = () => ({
  beginPath() {},
  clearRect() {},
  clip() {},
  drawImage() {},
  fill() {},
  fillRect() {},
  fillText() {},
  measureText(text) {
    return { width: String(text).length * 10 }
  },
  rect() {},
  restore() {},
  save() {},
  scale() {},
  setTransform() {},
  strokeText() {},
  translate() {},
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

const assertFrameDeltaPacing = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: false })
  overlay.ctx = makeContext()
  overlay.running = true
  overlay.lastTs = 1000
  overlay.frameEMA = 16
  const sprite = {
    img: makeCanvas(),
    sx: 0,
    sy: 0,
    w: 20,
    h: 10,
    x: 10000, // far enough to stay on stage for the whole run
    y: 20,
    vx: 1,
    ttlMs: 50000,
    priority: 1,
  }
  overlay.active.push(sprite)
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${message} (got ${actual}, want ${expected})`)

  // A regular frame advances by its interval.
  overlay._loop(1016)
  near(overlay.active[0].x, 9984, `${label}: a regular frame advances by the frame interval`)

  // A missed vsync (33 ms rAF gap) was already shown as a repeated frame. The
  // next frame must NOT jump two steps to catch up: that "hold, then double
  // jump" is the visible judder. It advances by the smoothed interval instead.
  overlay._loop(1049)
  near(
    overlay.active[0].x,
    9966.3,
    `${label}: a missed frame advances by the smoothed interval, not the raw gap`,
  )
  near(overlay.active[0].ttlMs, 49966.3, `${label}: lifetime tracks the smoothed delta`)

  // A long main-thread hitch is not repaid either (samples are capped), so
  // recovery is a normal step rather than a teleport.
  overlay._loop(1249)
  near(overlay.active[0].x, 9945.37, `${label}: a hitch does not teleport comments`)

  // A sustained lower frame rate converges back to real-time speed.
  let ts = 1249
  for (let i = 0; i < 80; i++) overlay._loop((ts += 33))
  const before = overlay.active[0].x
  overlay._loop((ts += 33))
  assert.ok(
    Math.abs(before - overlay.active[0].x - 33) < 0.05,
    `${label}: a steady 30 fps converges to real-time motion`,
  )
  const rested = overlay.active[0].x
  const restedTtl = overlay.active[0].ttlMs

  // A hidden/frozen tab produces a huge gap: pause, do not teleport or expire.
  overlay._loop(ts + 60_000)
  assert.equal(overlay.active.length, 1, `${label}: long gaps should not expire active comments`)
  assert.equal(
    overlay.active[0].x,
    rested,
    `${label}: long gaps should not teleport active comments`,
  )
  assert.equal(
    overlay.active[0].ttlMs,
    restedTtl,
    `${label}: long gaps should not advance lifetime`,
  )
}

const assertRasterBudget = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: false, spawnPerFrame: 4, rasterBudgetMs: 1000 })
  overlay.canvas = makeCanvas()
  let rasterCalls = 0
  const realRasterize = overlay._rasterize.bind(overlay)
  overlay._rasterize = (...args) => {
    rasterCalls++
    return realRasterize(...args)
  }

  assert.equal(overlay.push(payload("pump a")), true, `${label}: push accepts a comment`)
  assert.equal(overlay.push(payload("pump b")), true, `${label}: push accepts a second comment`)
  // The caller's stack (the video/chat path) must not pay for text rasterization.
  assert.equal(rasterCalls, 0, `${label}: push defers rasterization to the frame`)
  assert.equal(
    overlay.pending.length - overlay.pendingHead,
    2,
    `${label}: payloads wait in the pending queue`,
  )
  assert.equal(overlay._readyCount(), 0, `${label}: nothing is ready before a frame runs`)

  // The frame loop rasterizes under budget and admits in the same tick.
  overlay.ctx = makeContext()
  overlay.running = true
  overlay.lastTs = 1000
  overlay._loop(1016)
  assert.equal(rasterCalls, 2, `${label}: the frame rasterizes queued payloads`)
  assert.equal(overlay.active.length, 2, `${label}: the frame admits rasterized sprites`)
}

const assertRasterBudgetBounds = (label, Overlay) => {
  // A zero budget must still make progress one item per frame, never a burst.
  const overlay = new Overlay({ dpr: 1, dedup: false, spawnPerFrame: 10, rasterBudgetMs: 0 })
  overlay.canvas = makeCanvas()
  let calls = 0
  const real = overlay._rasterize.bind(overlay)
  overlay._rasterize = (...args) => {
    calls++
    return real(...args)
  }
  for (let i = 0; i < 5; i++) overlay.push(payload("bound " + i))
  overlay.ctx = makeContext()
  overlay.running = true
  overlay.lastTs = 1000
  overlay._loop(1016)
  assert.equal(calls, 1, `${label}: budget 0 rasterizes exactly one item per frame`)
  assert.equal(overlay.active.length, 1, `${label}: only the budgeted item is admitted this frame`)
  assert.equal(
    overlay.pending.length - overlay.pendingHead,
    4,
    `${label}: the rest wait for later frames`,
  )
}

const assertMembershipStaysFast = (label, Overlay) => {
  const overlay = new Overlay({
    dpr: 1,
    dedup: false,
    durationScale: 1,
    lengthSpread: true,
    spreadStrength: 1,
    tierDurations: [6000, 7500, 10000],
  })
  overlay.canvas = makeCanvas()
  const longText = "x".repeat(200)
  const membership = overlay._prepare(payload(longText, { kind: "membership", tier: 2 }), 0)
  const normal = overlay._prepare(payload(longText, { kind: "text", tier: 2 }), 0)
  assert.equal(membership.dur, 6000, `${label}: membership uses the fast duration`)
  assert.equal(normal.dur > 6000, true, `${label}: long normal text still spreads slower`)
}

// Regression guard for the periodic jolt: comments must share atlas pages that
// are recycled once nothing on screen uses them, never one <canvas> each.
const assertAtlasRecycling = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: false, maxActive: 5000, minActive: 5000 })
  overlay.canvas = makeCanvas()
  overlay.ctx = makeContext()
  overlay.w = 640
  overlay.h = 360
  overlay.laneTop = 0
  overlay.laneH = 24
  overlay.laneCount = 10
  overlay.lanes = new Array(10).fill(0)
  overlay.dynamicCap = 5000
  // ~92 chars measure ~920px wide: two slots per 2048px shelf and a handful
  // of shelves per 256px page, so 40 sprites need several pages.
  const text = i => "x".repeat(90) + i
  const spawn = (from, to) => {
    for (let i = from; i < to; i++) {
      assert.equal(overlay._spawn(payload(text(i)), 0.5), true, `${label}: spawn ${i} accepted`)
    }
  }
  const refs = () => overlay._pages.reduce((n, page) => n + page.sprites, 0)
  // Same raster key as _prepare() builds for these payloads (emphasis 0 => 0.9x font).
  const probe = t =>
    overlay._rasterize([{ t }], "#ffffff", Math.round(overlay.cfg.fontPx * 0.9), false)

  spawn(0, 40)
  const filled = overlay._pages.length
  assert.equal(filled >= 2 && filled <= 4, true, `${label}: 40 wide sprites span a few atlas pages`)
  assert.equal(
    overlay.active.every(a => a.img === a.page.canvas && a.sw > 0 && a.sh > 0),
    true,
    `${label}: sprites are drawn from a sub-rect of their atlas page`,
  )
  assert.equal(refs(), 40, `${label}: every on-screen sprite holds its page`)
  const hit = probe(text(0))
  assert.equal(hit.page, overlay._pages[0], `${label}: repeated text hits the cached slot`)
  assert.equal(hit.gen, 1, `${label}: cached slot records its page generation`)

  // While the pages are in use, more comments open a new page: nothing on
  // screen may ever be overwritten.
  spawn(40, 80)
  const busy = overlay._pages.length
  assert.equal(busy > filled, true, `${label}: busy pages are never recycled, new ones open`)
  assert.equal(
    overlay._pages.every(page => page.gen === 1),
    true,
    `${label}: no page was wiped`,
  )

  // Expire everything, then refill: the same pages are wiped and reused and the
  // stale cache entry is rejected rather than pointing at recycled pixels.
  for (const sprite of overlay.active) sprite.ttlMs = 0
  overlay.running = true
  overlay.lastTs = 1000
  overlay._loop(1016)
  assert.equal(overlay.active.length, 0, `${label}: sprites expired`)
  assert.equal(refs(), 0, `${label}: expired sprites release their pages`)
  spawn(100, 140)
  assert.equal(overlay._pages.length, busy, `${label}: refilling recycles pages instead of growing`)
  assert.equal(overlay._pages[0].gen, 2, `${label}: the oldest free page was wiped first`)
  const again = probe(text(0))
  assert.notEqual(again, hit, `${label}: a slot on a recycled page is not served from cache`)
  assert.equal(again.gen, again.page.gen, `${label}: the fresh slot is current`)

  // Oversized text cannot share a page and gets a private bitmap instead.
  const big = probe("y".repeat(250))
  assert.equal(big.page, null, `${label}: oversized text falls back to a standalone bitmap`)
  assert.equal(
    big.sx === 0 && big.sy === 0 && big.sw > 2048,
    true,
    `${label}: standalone bitmap geometry`,
  )

  overlay.clear()
  assert.equal(refs(), 0, `${label}: clear() releases every page`)
  overlay.detach()
  assert.equal(overlay._pages.length, 0, `${label}: detach() drops the atlas`)
}

const assertIdleCanvasSkip = (label, Overlay) => {
  let clears = 0
  const overlay = new Overlay({ dpr: 1, dedup: false })
  overlay.ctx = {
    ...makeContext(),
    clearRect() {
      clears++
    },
  }
  overlay.running = true
  overlay.lastTs = 1000
  overlay._dirty = false

  // No sprites + a clean canvas: the loop must not clear or composite anything.
  overlay._loop(1016)
  assert.equal(clears, 0, `${label}: idle frames skip the canvas clear`)

  // clear() (seek / navigation) marks the canvas dirty so the stale frame is
  // wiped exactly once, then the loop idles again.
  overlay.clear()
  overlay._loop(1032)
  assert.equal(clears, 1, `${label}: clear() forces one wipe`)
  overlay._loop(1048)
  assert.equal(clears, 1, `${label}: the wipe happens once, then idles again`)
}

const assertMotionSmoothness = (label, Overlay) => {
  const draws = []
  const overlay = new Overlay({ dpr: 1.5, dedup: false, opacity: 1 })
  overlay.ctx = {
    ...makeContext(),
    drawImage(img, sx, sy, sw, sh, x, y, w, h) {
      draws.push({ img, sx, sy, sw, sh, x, y, w, h })
    },
  }
  overlay.running = true
  overlay.lastTs = 1000
  overlay.active.push({
    img: makeCanvas(),
    sx: 0,
    sy: 0,
    w: 101,
    h: 27,
    x: 100.37,
    y: 40.9,
    vx: 0.2,
    ttlMs: 5000,
    priority: 1,
  })

  overlay._loop(1016)

  assert.equal(draws.length, 1, `${label}: active sprite should be drawn once`)
  const near = (a, b) => Math.abs(a - b) < 1e-6
  // Horizontal position must stay exact (sub-pixel): snapping x to the device
  // grid makes constant-velocity motion stair-step, which reads as judder.
  assert.equal(
    near(draws[0].x, 100.37 - 0.2 * 16),
    true,
    `${label}: draw x should keep its exact fractional position`,
  )
  assert.equal(
    near(draws[0].x * 1.5, Math.round(draws[0].x * 1.5)),
    false,
    `${label}: draw x must not be quantised to the device pixel grid`,
  )
  // Lane y never changes, so it stays snapped for crisp text edges.
  assert.equal(
    near(draws[0].y * 1.5, Math.round(draws[0].y * 1.5)),
    true,
    `${label}: draw y should land on the device pixel grid`,
  )
  assert.equal(draws[0].w, 101, `${label}: bitmap width should be preserved`)
  assert.equal(draws[0].h, 27, `${label}: bitmap height should be preserved`)
}

const assertTypeGatingAndRoleScale = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: false })
  overlay.canvas = makeCanvas()

  assert.equal(
    overlay._typeVisible(payload("x", { kind: "paid" })),
    true,
    `${label}: super chats visible by default`,
  )
  assert.equal(
    overlay._typeVisible(payload("x", { authorType: "member" })),
    true,
    `${label}: members visible by default`,
  )

  overlay.setConfig({
    showPaid: false,
    showMember: false,
    roleScale: { member: 1.5, owner: 1, moderator: 1, paid: 2 },
  })
  assert.equal(
    overlay._typeVisible(payload("x", { kind: "paid" })),
    false,
    `${label}: hidden super chats should be gated`,
  )
  assert.equal(
    overlay._typeVisible(payload("x", { authorType: "member" })),
    false,
    `${label}: hidden members should be gated`,
  )
  assert.equal(
    overlay._typeVisible(payload("x", { authorType: "normal" })),
    true,
    `${label}: normal users stay visible`,
  )

  assert.equal(
    overlay._roleScale(payload("x", { authorType: "member" })),
    1.5,
    `${label}: member font scale should apply`,
  )
  assert.equal(
    overlay._roleScale(payload("x", { kind: "paid" })),
    2,
    `${label}: paid font scale should apply to super chats`,
  )
  assert.equal(overlay._roleScale(payload("x")), 1, `${label}: normal font scale defaults to 1`)

  // Gated types must be dropped before they reach the queue.
  overlay.setConfig({ showPaid: false, showMember: true })
  assert.equal(
    overlay.push(payload("paid", { kind: "paid" })),
    false,
    `${label}: gated push is rejected`,
  )
  assert.equal(overlay.pending.length, 0, `${label}: gated comment should not be queued`)
  assert.equal(overlay.push(payload("plain")), true, `${label}: visible comment is queued`)
}

const assertFlowDirectionAndDensity = (label, Overlay) => {
  const ltr = new Overlay({ dpr: 1, dedup: false, flowDirection: "ltr", lengthSpread: false })
  ltr.canvas = makeCanvas()
  ltr.ctx = makeContext()
  ltr.w = 320
  ltr.h = 180
  ltr.laneTop = 0
  ltr.laneH = 24
  ltr.laneCount = 3
  ltr.lanes = [0, 0, 0]
  ltr.dynamicCap = 10

  assert.equal(ltr._spawn(payload("hello"), 0.5), true, `${label}: ltr spawn accepted`)
  assert.equal(ltr.active[0].x < 0, true, `${label}: ltr comments start left of the stage`)
  const before = ltr.active[0].x
  ltr.running = true
  ltr.lastTs = 1000
  ltr._loop(1016)
  assert.equal(ltr.active[0].x > before, true, `${label}: ltr comments move to the right`)

  const bottom = new Overlay({ dpr: 1, dedup: false, density: "bottom" })
  bottom.laneCount = 4
  bottom.lanes = [0, 0, 0, 0]
  assert.equal(bottom._pickLane(0), 3, `${label}: bottom density fills the lowest lane first`)

  const top = new Overlay({ dpr: 1, dedup: false, density: "top" })
  top.laneCount = 4
  top.lanes = [0, 0, 0, 0]
  assert.equal(top._pickLane(0), 0, `${label}: top density fills the first lane first`)

  const fit = new Overlay({ dpr: 1, dedup: false, maxWidthPct: 0.5 })
  fit.w = 100 // max width 50px; the stub measures 10px per character
  assert.equal(fit._fitWidth("abc", 24), "abc", `${label}: narrow comments are unchanged`)
  assert.equal(
    fit._fitWidth("abcdefghij", 24).endsWith("…"),
    true,
    `${label}: wide comments are trimmed with an ellipsis`,
  )
}

const assertPinAndHitTest = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: false })
  overlay.ctx = makeContext()
  overlay.running = true
  overlay.lastTs = 1000
  overlay.active.push({
    img: makeCanvas(),
    sx: 0,
    sy: 0,
    w: 100,
    h: 20,
    x: 50,
    y: 100,
    vx: 1,
    ttlMs: 5000,
    priority: 1,
    id: 1,
    index: 0,
    active: true,
  })

  assert.equal(
    overlay._hitTest(60, 100)?.id,
    1,
    `${label}: hit test finds the comment under the point`,
  )
  assert.equal(overlay._hitTest(500, 400), null, `${label}: hit test misses empty space`)

  const sprite = overlay._hitTest(60, 100)
  overlay._togglePin(sprite)
  assert.equal(sprite.pinned, true, `${label}: toggle pins a comment`)

  overlay._loop(1016)
  assert.equal(overlay.active[0].x, 50, `${label}: pinned comments do not move`)
  assert.equal(overlay.active[0].ttlMs, 5000, `${label}: pinned comments do not expire`)

  overlay._togglePin(sprite)
  assert.equal(sprite.pinned, false, `${label}: a second toggle unpins`)
}

// Extension engine: the stage frame gets no pointer events, so content.js
// drives pinning and dragging through the point-based API.
const assertStagePointerApi = (label, Overlay) => {
  const overlay = new Overlay({ dpr: 1, dedup: false })
  overlay.ctx = makeContext()
  overlay.active.push({
    img: makeCanvas(),
    sx: 0,
    sy: 0,
    w: 100,
    h: 20,
    x: 50,
    y: 100,
    vx: 1,
    ttlMs: 5000,
    priority: 1,
    id: 1,
    index: 0,
    active: true,
  })
  const sprite = overlay.active[0]

  assert.equal(overlay.hitState(60, 100), 1, `${label}: hitState reports a comment`)
  assert.equal(overlay.hitState(500, 400), 0, `${label}: hitState reports empty space`)
  assert.equal(overlay.dragStart(60, 100), false, `${label}: an unpinned comment cannot be dragged`)
  assert.equal(overlay.pinAt(60, 100), true, `${label}: pinAt pins the comment under the point`)
  assert.equal(overlay.hitState(60, 100), 2, `${label}: hitState reports a pinned comment`)

  assert.equal(overlay.dragStart(60, 100), true, `${label}: a pinned comment can be dragged`)
  overlay.dragTo(160, 150)
  assert.deepEqual([sprite.x, sprite.y], [150, 150], `${label}: drag keeps the grab offset`)
  overlay.dragEnd()
  overlay.dragTo(0, 0)
  assert.deepEqual([sprite.x, sprite.y], [150, 150], `${label}: moves after dragEnd are ignored`)

  overlay.setConfig({ pinComments: false })
  assert.equal(overlay.hitState(160, 150), 0, `${label}: pinning off reports nothing`)
  assert.equal(overlay.pinAt(160, 150), false, `${label}: pinning off ignores pinAt`)
}

// Tiers must look different: a tier sets the speed, whatever the comment's
// width, and a faster comment never runs into a slower one in its lane.
const assertTierSpeedAndLaneCatchUp = (label, Overlay) => {
  const overlay = new Overlay({
    dpr: 1,
    dedup: false,
    lengthSpread: false,
    durationScale: 1,
    tierDurations: [2000, 4000, 6000],
    gapPx: 20,
  })
  overlay.canvas = makeCanvas()
  overlay.ctx = makeContext()
  overlay.w = 1000
  overlay.h = 180
  overlay.laneTop = 0
  overlay.laneH = 24
  overlay.laneCount = 2
  overlay.lanes = [0, 0]
  overlay.laneExit = [0, 0]
  overlay.dynamicCap = 10

  overlay._spawn(payload("short", { tier: 2 }), 0.5)
  overlay._spawn(payload("x".repeat(60), { tier: 2 }), 0.5)
  const [narrow, wide] = overlay.active
  assert.equal(narrow.vx, wide.vx, `${label}: width does not change a tier's speed`)
  assert.equal(wide.ttlMs > narrow.ttlMs, true, `${label}: a wider comment stays longer`)

  const fast = new Overlay({
    dpr: 1,
    dedup: false,
    lengthSpread: false,
    durationScale: 1,
    tierDurations: [2000, 4000, 6000],
  })
  fast.canvas = makeCanvas()
  fast.ctx = makeContext()
  fast.w = 1000
  fast.laneTop = 0
  fast.laneH = 24
  fast.laneCount = 2
  fast.lanes = [0, 0]
  fast.laneExit = [0, 0]
  fast.dynamicCap = 10
  fast._spawn(payload("slow one", { tier: 2 }), 0.5)
  fast._spawn(payload("fast", { tier: 0 }), 0.5)
  assert.equal(
    fast.active[1].vx > fast.active[0].vx * 2.5,
    true,
    `${label}: the fast tier is clearly faster`,
  )
  assert.equal(
    fast.active[0].y !== fast.active[1].y,
    true,
    `${label}: a fast comment does not follow a slow one into its lane`,
  )

  // The slow comment's lane opens to fast comments only once it is far enough
  // ahead, later than its entry edge alone would allow.
  const vxFast = fast.active[1].vx
  const readyAt = fast._laneReadyAt(0, vxFast)
  assert.equal(
    readyAt > fast.lanes[0],
    true,
    `${label}: catching up delays the lane past its entry time`,
  )
  assert.equal(
    fast._pickLane(readyAt - 1, vxFast),
    1,
    `${label}: before that, the other lane is used`,
  )
  assert.equal(
    fast._pickLane(readyAt + 1, vxFast),
    0,
    `${label}: after that, the lane is free again`,
  )
}

const assertWrapAndLineLayout = (label, Overlay) => {
  const wrapped = new Overlay({ dpr: 1, dedup: false, maxWidthPct: 0.5, wrapText: true })
  wrapped.w = 100 // max width 50px; the stub measures 10px per character
  const lines = wrapped._layoutLines("abcdefghij", 24)
  assert.equal(lines.length > 1, true, `${label}: wrapText wraps into multiple lines`)
  assert.equal(
    lines.every(line => line.length <= 5),
    true,
    `${label}: wrapped lines fit the configured width`,
  )

  const trimmed = new Overlay({ dpr: 1, dedup: false, maxWidthPct: 0.5, wrapText: false })
  trimmed.w = 100
  assert.equal(
    trimmed._layoutLines("abcdefghij", 24).length,
    1,
    `${label}: without wrapText the text stays on one line`,
  )

  const raster = new Overlay({
    dpr: 1,
    dedup: false,
    maxWidthPct: 0.5,
    wrapText: true,
    lineHeight: 20,
  })
  raster.w = 100
  const bmp = raster._rasterize([{ t: "abcdefghij" }], "#fff", 20, false)
  assert.equal(bmp.h > 20, true, `${label}: wrapped bitmaps are taller than a single line`)
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

  rasterize(overlay, "scale")
  overlay.setConfig({ outlineColor: "#ff0000" })
  assert.equal(overlay.cache.size, 0, `${label}: outline color changes should clear cached bitmaps`)

  rasterize(overlay, "scale")
  overlay.setConfig({ outlineBlur: 2 })
  assert.equal(overlay.cache.size, 0, `${label}: outline blur changes should clear cached bitmaps`)
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

  assert.equal(typeof overlay.clear, "function", `${label}: clear() should be available`)
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
assertFrameDeltaPacing("web", webOverlay)
assertRasterBudget("web", webOverlay)
assertRasterBudgetBounds("web", webOverlay)
assertMembershipStaysFast("web", webOverlay)
assertAtlasRecycling("web", webOverlay)
assertIdleCanvasSkip("web", webOverlay)
assertMotionSmoothness("web", webOverlay)
assertTypeGatingAndRoleScale("web", webOverlay)
assertFlowDirectionAndDensity("web", webOverlay)
assertPinAndHitTest("web", webOverlay)
assertTierSpeedAndLaneCatchUp("web", webOverlay)
assertWrapAndLineLayout("web", webOverlay)
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
assertFrameDeltaPacing("extension", extensionOverlay)
assertRasterBudget("extension", extensionOverlay)
assertRasterBudgetBounds("extension", extensionOverlay)
assertMembershipStaysFast("extension", extensionOverlay)
assertAtlasRecycling("extension", extensionOverlay)
assertIdleCanvasSkip("extension", extensionOverlay)
assertMotionSmoothness("extension", extensionOverlay)
assertTypeGatingAndRoleScale("extension", extensionOverlay)
assertFlowDirectionAndDensity("extension", extensionOverlay)
assertPinAndHitTest("extension", extensionOverlay)
assertStagePointerApi("extension", extensionOverlay)
assertTierSpeedAndLaneCatchUp("extension", extensionOverlay)
assertWrapAndLineLayout("extension", extensionOverlay)
assertLruCache("extension", extensionOverlay, (overlay, text) =>
  overlay._rasterize([{ t: text }], "#fff", 24, false),
)
assertRasterCacheInvalidation("extension", extensionOverlay, (overlay, text) =>
  overlay._rasterize([{ t: text }], "#fff", 24, false),
)
assertResizeGating("extension", extensionOverlay)
assertPriorityQueueAdmission("extension", extensionOverlay)
assertActiveCapEviction("extension", extensionOverlay)
assertLaneSelectionAndClear("extension", extensionOverlay)
assertPendingCompaction("extension", extensionOverlay)

console.log("danmaku ok")
