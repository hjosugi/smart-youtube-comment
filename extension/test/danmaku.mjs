// Engine tests specific to the extension: the liveness gate that keeps a
// background tab from flooding the video on return, and the compositor
// renderer (danmaku-dom.js). Runs both renderers in a VM with a fake DOM, a
// manual clock, manual timers and a manual requestAnimationFrame queue.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

let checks = 0
const ok = (value, message) => {
  checks++
  assert.ok(value, message)
}
const equal = (actual, expected, message) => {
  checks++
  assert.equal(actual, expected, message)
}

const makeContext2d = () => ({
  beginPath() {},
  clearRect() {},
  drawImage() {},
  fill() {},
  fillRect() {},
  fillText() {},
  measureText: text => ({ width: String(text).length * 10 }),
  restore() {},
  roundRect() {},
  save() {},
  scale() {},
  setTransform() {},
  strokeText() {},
})

const makeEnv = () => {
  const env = { now: 1000, frames: [], timers: [], timerId: 0, animations: [] }

  const makeStyle = () => {
    const props = new Map()
    return {
      setProperty: (name, value) => props.set(name, value),
      getPropertyValue: name => props.get(name) ?? "",
    }
  }

  const makeElement = tag => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      parent: null,
      style: makeStyle(),
      className: "",
      textContent: "",
      ownerDocument: null,
      get isConnected() {
        return Boolean(this.parent)
      },
      appendChild(child) {
        child.parent = this
        this.children.push(child)
        return child
      },
      remove() {
        if (!this.parent) return
        this.parent.children = this.parent.children.filter(child => child !== this)
        this.parent = null
      },
      getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0 }),
      getContext: () => makeContext2d(),
      animate(keyframes, options) {
        const anim = {
          el,
          keyframes,
          options,
          currentTime: 0,
          state: "running",
          onfinish: null,
          pause() {
            this.state = "paused"
          },
          play() {
            this.state = "running"
          },
          cancel() {
            this.state = "idle"
          },
          finish() {
            this.state = "finished"
            this.currentTime = options.duration
            this.onfinish?.()
          },
        }
        env.animations.push(anim)
        return anim
      },
    }
    el.ownerDocument = env.document
    return el
  }

  env.document = {
    head: null,
    documentElement: null,
    timeline: { currentTime: 0 },
    createElement: makeElement,
    createTextNode: value => ({ nodeType: 3, textContent: value, remove() {} }),
    getElementById: () => null,
  }
  env.document.head = makeElement("head")
  env.document.documentElement = makeElement("html")

  const sandbox = {
    console,
    devicePixelRatio: 1,
    document: env.document,
    getComputedStyle: () => ({ position: "relative" }),
    globalThis: null,
    self: null,
    performance: { now: () => env.now },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(callback) {
      env.frames.push(callback)
      return env.frames.length
    },
    cancelAnimationFrame() {
      env.frames.length = 0
    },
    setTimeout(callback, ms = 0) {
      env.timers.push({ id: ++env.timerId, at: env.now + ms, callback })
      return env.timerId
    },
    clearTimeout(id) {
      env.timers = env.timers.filter(timer => timer.id !== id)
    },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  for (const file of ["scoring.js", "danmaku.js", "danmaku-dom.js"]) {
    runInNewContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), sandbox, {
      filename: `extension/${file}`,
    })
  }

  env.sandbox = sandbox
  env.SYCDanmaku = sandbox.SYCDanmaku
  env.makeElement = makeElement
  // Let `ms` pass: timers that come due fire, no frame is produced (which is
  // what a hidden tab looks like to the stage).
  env.advance = ms => {
    env.now += ms
    const due = env.timers.filter(timer => timer.at <= env.now).sort((a, b) => a.at - b.at)
    env.timers = env.timers.filter(timer => timer.at > env.now)
    for (const timer of due) timer.callback()
  }
  // Let `ms` pass, then run the frame that was requested (if any).
  env.frame = (ms = 16) => {
    env.advance(ms)
    const callbacks = env.frames.splice(0)
    for (const callback of callbacks) callback(env.now)
    return callbacks.length
  }
  env.pendingFrames = () => env.frames.length
  env.pendingTimers = () => env.timers.length
  return env
}

const payload = (text, extra = {}) => ({
  text,
  parts: [{ t: text }],
  tier: 1,
  durationMs: 5000,
  score: 0.3,
  emphasis: 0.3,
  authorType: "normal",
  kind: "text",
  ...extra,
})

const queued = overlay => overlay.pending.length - overlay.pendingHead

// --- liveness gate: comments are live, never queued for later ------------------

for (const name of ["DanmakuOverlay", "CompositorOverlay"]) {
  const label = name === "DanmakuOverlay" ? "canvas" : "compositor"
  // How long until a pushed comment is on stage: the canvas renderer admits on
  // the next frame, the compositor renderer in the next batch.
  const beat = name === "DanmakuOverlay" ? 16 : 260

  {
    // A hidden tab: frames stop, comments keep arriving, then the tab returns.
    const env = makeEnv()
    const overlay = new env.SYCDanmaku[name]({ dpr: 1, dedup: false })
    overlay.attach(env.makeElement("div"))
    env.frame()
    equal(overlay.push(payload("before hiding")), true, `${label}: a comment is accepted while frames run`)
    env.frame(beat)
    equal(overlay.active.length, 1, `${label}: and it is shown`)

    // No frame runs from here on (the tab is hidden). Timers still fire.
    equal(overlay.push(payload("just hidden")), true, `${label}: right after the last frame a comment still queues`)
    env.advance(800)
    let accepted = 0
    for (let i = 0; i < 500; i++) {
      env.advance(100)
      if (overlay.push(payload(`while hidden ${i}`))) accepted++
    }
    equal(accepted, 0, `${label}: comments are refused while no frame is being produced`)
    ok(queued(overlay) <= 1, `${label}: nothing piles up in the background`)

    // Back in the foreground: the first frame arrives very late.
    const shownBefore = overlay.shown
    env.frame(16)
    env.frame(beat)
    equal(overlay.shown, shownBefore, `${label}: nothing from the hidden period is shown on return`)
    equal(queued(overlay), 0, `${label}: the stale backlog is discarded`)
    ok(overlay.dropped >= 500, `${label}: the refused comments are counted as dropped`)

    equal(overlay.push(payload("after return")), true, `${label}: live comments flow again`)
    env.frame(beat)
    equal(overlay.shown, shownBefore + 1, `${label}: and are shown`)
  }

  {
    // Paused with the video (stop): nothing is accepted, nothing floods on play.
    const env = makeEnv()
    const overlay = new env.SYCDanmaku[name]({ dpr: 1, dedup: false })
    overlay.attach(env.makeElement("div"))
    env.frame()
    overlay.stop()
    let accepted = 0
    for (let i = 0; i < 100; i++) {
      env.advance(50)
      if (overlay.push(payload(`while paused ${i}`))) accepted++
    }
    equal(accepted, 0, `${label}: comments are refused while paused`)
    overlay.start()
    env.frame()
    env.frame(beat)
    equal(overlay.active.length, 0, `${label}: resuming does not release a backlog`)
    equal(overlay.push(payload("after resume")), true, `${label}: comments are accepted again after start()`)
  }

  {
    // A comment that waited too long in the queue is no longer live.
    const env = makeEnv()
    const overlay = new env.SYCDanmaku[name]({ dpr: 1, dedup: false, maxWaitMs: 2000, spawnPerFrame: 1 })
    overlay.attach(env.makeElement("div"))
    env.frame()
    for (let i = 0; i < 4; i++) overlay.push(payload(`waiting ${i}`))
    for (const item of overlay.pending) item.at -= 5000
    overlay.push(payload("fresh"))
    env.frame(beat)
    env.frame(beat)
    equal(overlay.active.length, 1, `${label}: only the fresh comment is shown`)
    equal(overlay.dropped, 4, `${label}: comments older than maxWaitMs are dropped`)
  }
}

// --- compositor renderer -----------------------------------------------------

const xOf = transform => Number(/^translate\((-?[\d.e+-]+)px/.exec(transform)[1])
const near = (a, b) => Math.abs(a - b) < 1e-6
const LINGER_MS = 1500 // how long a comment keeps moving off-stage after leaving
const SLACK_PX = 8

{
  const env = makeEnv()
  const { CompositorOverlay } = env.SYCDanmaku
  const player = env.makeElement("div")
  const overlay = new CompositorOverlay({ dpr: 1, dedup: false })
  overlay.attach(player)
  const layer = overlay.layer
  equal(layer.className, "syc-danmaku-layer", "compositor: a layer element is attached to the player")
  equal(overlay.stats().renderer, "compositor", "compositor: stats name the renderer")

  env.frame()
  equal(env.pendingFrames(), 0, "compositor: no frame is requested while nothing is queued")
  equal(env.pendingTimers(), 0, "compositor: and no timer runs")

  // Comments that arrive within one batch window are added in a single frame.
  overlay.push(payload("hello world"))
  equal(env.pendingTimers(), 1, "compositor: a comment schedules a batch")
  equal(env.pendingFrames(), 0, "compositor: not a frame of its own")
  env.advance(100)
  overlay.push(payload("second"))
  equal(env.pendingTimers(), 1, "compositor: a comment arriving meanwhile joins that batch")
  equal(env.frame(150), 1, "compositor: the batch runs in one frame")
  equal(overlay.active.length, 2, "compositor: which admits both comments")
  equal(layer.children.length, 2, "compositor: as one element each on the layer")
  equal(env.pendingFrames() + env.pendingTimers(), 0, "compositor: and nothing stays scheduled afterwards")

  const [sprite, second] = overlay.active
  const [anim, anim2] = env.animations.slice(-2)
  equal(sprite.el.textContent, "hello world", "compositor: text is set as text content")
  equal(anim.options.easing, "linear", "compositor: motion is a linear animation")
  equal(anim.options.delay, undefined, "compositor: without a delay (its end would cost a main-thread frame)")
  equal(anim.keyframes.length, 2, "compositor: between two keyframes")
  ok(
    anim.keyframes.every(frame => Object.keys(frame).join() === "transform"),
    "compositor: that animate transform only, so the compositor can run it",
  )
  // The head crosses the stage in the tier time, whatever the comment's width.
  const speed = (overlay.w + overlay.gap) / overlay._duration(payload("hello world"))
  const travel = (overlay.w + sprite.w + SLACK_PX) / speed
  equal(anim.keyframes[0].transform, `translate(${overlay.w}px, ${overlay._top(sprite)}px)`, "compositor: starting at the right edge")
  ok(near(sprite.doneMs, travel), "compositor: it has left the stage after crossing it at the tier's speed")
  ok(near(anim.options.duration, travel + LINGER_MS), "compositor: and keeps moving off-stage until a batch removes it")
  ok(near(xOf(anim.keyframes[1].transform), -sprite.w - SLACK_PX - speed * LINGER_MS), "compositor: at the same speed")

  // Each comment enters one batch window after it arrived: the second came
  // 100 ms after the first, so it starts that much farther off-stage.
  ok(near(xOf(anim2.keyframes[0].transform), overlay.w + second.vx * 100), "compositor: a later comment of the batch starts farther back")
  ok(near(second.doneMs, 100 + (overlay.w + second.w + SLACK_PX) / second.vx), "compositor: and so enters, and leaves, that much later")
  anim2.currentTime = 100
  ok(near(overlay._spriteX(second), overlay.w), "compositor: it reaches the edge exactly when it is due")
  ok(second.y > sprite.y, "compositor: the first has not cleared the edge by then, so it takes the next lane")
  ok(
    near(overlay.lanes[1], env.now + 100 + (second.w + overlay.gap) / second.vx),
    "compositor: and that lane is booked from when it enters, not from when it was added",
  )

  // Position follows the animation clock; nothing is advanced per frame.
  anim.currentTime = travel / 2
  const mid = overlay._spriteX(sprite)
  ok(near(mid, (overlay.w + (-sprite.w - SLACK_PX)) / 2), "compositor: position is read from the animation clock")
  equal(overlay._hitTest(mid + 5, sprite.y), sprite, "compositor: hit testing uses that position")
  equal(overlay._hitTest(mid - 50, sprite.y), null, "compositor: and misses beside the comment")

  // Pin holds the comment in place; unpin sends it on from there.
  overlay.setPinned(sprite, true)
  equal(sprite.anim, null, "compositor: a pinned comment has no running animation")
  equal(anim.state, "idle", "compositor: its animation was cancelled")
  equal(sprite.el.style.transform, `translate(${mid}px, ${overlay._top(sprite)}px)`, "compositor: and it is held where it was")
  ok(overlay.dragStart(mid + 5, sprite.y), "compositor: a pinned comment can be dragged")
  overlay.dragTo(mid + 105, sprite.y + 40)
  overlay.dragEnd()
  ok(near(sprite.x, mid + 100), "compositor: dragging moves it")
  ok(sprite.el.style.transform.startsWith(`translate(${sprite.x}px`), "compositor: and moves its element")
  overlay.setPinned(sprite, false)
  const resumed = env.animations.at(-1)
  equal(resumed.keyframes[0].transform, `translate(${sprite.x}px, ${overlay._top(sprite)}px)`, "compositor: unpinning continues from the dragged position")
  ok(near(sprite.doneMs, (sprite.x + sprite.w + SLACK_PX) / sprite.vx), "compositor: at the same speed")

  // A comment that has left is removed by the next batch, not by a frame of its own.
  resumed.currentTime = sprite.doneMs
  equal(overlay.active.length, 2, "compositor: a comment that just left stays until a batch comes by")
  overlay.push(payload("third"))
  env.frame(250)
  equal(overlay.active.includes(sprite), false, "compositor: the next batch removes it")
  equal(resumed.state, "idle", "compositor: cancelling its animation")
  equal(layer.children.length, 2, "compositor: and its element, while adding the new comment")
  // With no batch in time the animation ends and removes the comment itself.
  anim2.finish()
  equal(overlay.active.includes(second), false, "compositor: a comment whose animation ends is removed too")
  equal(layer.children.length, 1, "compositor: with its element")

  // Pause with the video.
  const moving = env.animations.at(-1)
  overlay.push(payload("queued at pause"))
  equal(env.pendingTimers(), 1, "compositor: a batch is scheduled")
  overlay.stop()
  equal(env.pendingTimers(), 0, "compositor: stop() cancels the scheduled batch")
  equal(moving.state, "paused", "compositor: and pauses comments in place")
  overlay.start()
  equal(moving.state, "running", "compositor: start() resumes them")
  env.frame()
  equal(overlay.active.length, 2, "compositor: and admits what was queued just before the pause")

  // Hide a user, clear, detach.
  overlay.push(payload("from bob", { author: "Bob", authorChannelId: "UCbob" }))
  overlay.push(payload("from bob again", { author: "Bob", authorChannelId: "UCbob" }))
  env.frame(250)
  equal(overlay.active.length, 4, "compositor: four comments on stage")
  const bob = overlay.active.find(a => a.channel === "UCbob")
  equal(overlay.hideAuthor(bob).channel, "UCbob", "compositor: hideAuthor reports who was hidden")
  equal(overlay.active.length, 2, "compositor: that author's comments leave")
  equal(layer.children.length, 2, "compositor: with their elements")
  overlay.clear()
  equal(layer.children.length, 0, "compositor: clear() removes every element")
  overlay.detach()
  equal(layer.isConnected, false, "compositor: detach() removes the layer")
}

{
  // A burst larger than one batch is spread over the following batches.
  const env = makeEnv()
  const overlay = new env.SYCDanmaku.CompositorOverlay({ dpr: 1, dedup: false })
  overlay.attach(env.makeElement("div"))
  env.frame()
  for (let i = 0; i < 50; i++) overlay.push(payload(`burst ${i}`))
  env.frame(250)
  equal(overlay.active.length, 40, "compositor: one batch adds a bounded number of comments")
  equal(env.pendingTimers(), 1, "compositor: and schedules the next batch for the rest")
  env.frame(250)
  equal(overlay.active.length, 50, "compositor: which adds them")
  equal(env.pendingFrames() + env.pendingTimers(), 0, "compositor: then the stage is idle again")
}

{
  // Layer style follows settings, including for comments already on screen.
  const env = makeEnv()
  const overlay = new env.SYCDanmaku.CompositorOverlay({ dpr: 1, dedup: false })
  overlay.attach(env.makeElement("div"))
  overlay.setConfig({ outlineWidth: 4, outlineAlpha: 0.5, outlineColor: "#112233", opacity: 0.6, fontWeight: 900 })
  const style = overlay.layer.style
  equal(style.getPropertyValue("--syc-stroke-width"), "4px", "compositor: outline width is a layer variable")
  equal(style.getPropertyValue("--syc-stroke-color"), "rgba(17,34,51,0.5)", "compositor: outline color carries its opacity")
  equal(style.opacity, "0.6", "compositor: opacity is applied to the layer")
  equal(style.fontWeight, "900", "compositor: font weight is applied to the layer")

  // Super Chat band, role color and emoji parts.
  overlay.push(payload("thanks", { kind: "paid", amount: "¥500", paidColor: "#e62117", author: "Alice" }))
  overlay.push(payload("mod here", { authorType: "moderator" }))
  overlay.push({ ...payload("hi :smile:"), parts: [{ t: "hi " }, { u: "https://yt3.ggpht.com/emoji=s24", a: ":smile:" }] })
  env.sandbox.SYCEmoji = { sanitizeUrl: url => (url.startsWith("https://yt3.ggpht.com/") ? url : "") }
  env.frame(250)
  const [paid, mod, emoji] = overlay.active
  equal(paid.el.style.background, "rgba(230,33,23,0.92)", "compositor: a Super Chat gets its tier band")
  equal(paid.el.style.color, "#ffffff", "compositor: with white text")
  equal(paid.el.textContent, "Alice: ¥500 thanks", "compositor: and author and amount in front")
  equal(mod.el.style.color, "#5e9bff", "compositor: roles keep their colors")
  const kinds = emoji.el.children.map(child => child.tagName || "#text")
  equal(kinds.join(), "#text,IMG", "compositor: emoji parts become images between text nodes")
  equal(emoji.el.children[1].src, "https://yt3.ggpht.com/emoji=s24", "compositor: from the sanitized URL")

  // No cap of its own: "Max comments on screen" decides, however high it is set.
  overlay.setConfig({ maxActive: 2000 })
  ok(overlay.dynamicCap > 400, "compositor: the on-screen cap is the setting, not a layer budget")
  overlay.setConfig({ maxActive: 30 })
  equal(overlay.dynamicCap, 30, "compositor: and a low setting is kept")
}

console.log(`extension danmaku ok (${checks} assertions)`)
