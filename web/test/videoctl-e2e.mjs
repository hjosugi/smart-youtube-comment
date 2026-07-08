// Playwright test for the custom video controls, driven by a FAKE player (no real
// YouTube): tap toggles play/pause, the play button toggles, the seek bar seeks,
// and teardown removes the overlay.

import { chromium } from "playwright"
import { serveWeb } from "./_serve.mjs"

const waitFor = async (fn, timeoutMs = 5000) => {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await new Promise(done => setTimeout(done, 25))
  }
}

let apiCalls = 0
const apiRequests = []
const { port, close } = await serveWeb({
  handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname !== "/api/livechat") return false
    apiCalls += 1
    const offset = url.searchParams.get("offset")
    apiRequests.push({
      cont: url.searchParams.get("cont"),
      video: url.searchParams.get("video"),
      offset,
    })
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    })
    res.end(
      JSON.stringify({
        messages: [
          {
            id: `m${apiCalls}-${offset ?? "resolve"}`,
            author: "@tester",
            text: `hello ${apiCalls}`,
            offsetMs: Number(offset ?? 0),
          },
        ],
        continuation: "c",
        timeoutMs: 20,
        ended: false,
        isReplay: true,
      }),
    )
    return true
  },
})
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on("pageerror", e => errors.push(e.message))

await page.addInitScript(() => {
  globalThis.__sycHidden = false
  globalThis.__sycPlayerStateHandlers = []
  const hiddenDescriptor = {
    configurable: true,
    get: () => Boolean(globalThis.__sycHidden),
  }
  try {
    Object.defineProperty(document, "hidden", hiddenDescriptor)
  } catch {
    Object.defineProperty(Document.prototype, "hidden", hiddenDescriptor)
  }
  globalThis.__sycEmitPlayerState = state => {
    for (const handler of globalThis.__sycPlayerStateHandlers) handler({ data: state })
  }
  globalThis.YT = {
    Player: function Player(elementId, options) {
      let state = 2
      let currentTime = 0
      const host = document.getElementById(elementId)
      if (host) {
        const replacement = document.createElement("div")
        replacement.id = elementId
        host.replaceWith(replacement)
      }
      const player = {
        getCurrentTime: () => currentTime,
        getDuration: () => 120,
        getPlayerState: () => state,
        playVideo: () => {
          state = 1
          globalThis.__sycEmitPlayerState(1)
        },
        pauseVideo: () => {
          state = 2
          globalThis.__sycEmitPlayerState(2)
        },
        seekTo: s => {
          currentTime = s
        },
        destroy: () => {},
      }
      globalThis.__sycFakePlayer = player
      globalThis.__sycPlayerStateHandlers.push(e => {
        state = e.data
        options.events?.onStateChange?.(e)
      })
      setTimeout(() => options.events?.onReady?.({ target: player }), 0)
      return player
    },
  }
})

// boot the app (sets globalThis.SYCApp, which re-exports videoctl for testing)
await page.goto(`http://localhost:${port}/index.html`, { waitUntil: "load" })
await page.waitForFunction(() => globalThis.SYCApp?.videoctl)

const r = await page.evaluate(async () => {
  const { mountControls, fmtTime } = globalThis.SYCApp.videoctl

  const calls = { play: 0, pause: 0, seek: [] }
  let state = 2 // paused
  const player = {
    getPlayerState: () => state,
    getDuration: () => 100,
    getCurrentTime: () => 30,
    playVideo: () => {
      calls.play += 1
      state = 1
    },
    pauseVideo: () => {
      calls.pause += 1
      state = 2
    },
    seekTo: s => calls.seek.push(s),
  }

  const stage = document.createElement("div")
  document.body.append(stage)
  const unmount = mountControls(stage, player, { hideMs: 5000 })

  const wrap = stage.querySelector(".vctl")
  const out = {
    fmt: [fmtTime(0), fmtTime(65), fmtTime(3661)],
    barExists: !!stage.querySelector(".vctl-bar"),
  }

  wrap.click() // tap video -> play
  out.tapPlays = calls.play === 1 && state === 1
  wrap.click() // tap again -> pause
  out.tapPauses = calls.pause === 1 && state === 2

  stage.querySelector(".vctl-play").click() // button toggles (now plays)
  out.btnToggles = calls.play === 2 && state === 1

  const seek = stage.querySelector(".vctl-seek")
  seek.value = "500"
  seek.dispatchEvent(new Event("change", { bubbles: true }))
  out.seekSeeks = calls.seek.length === 1 && calls.seek[0] === 50 // 500/1000 * duration(100)

  seek.value = "250"
  seek.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  seek.dispatchEvent(new Event("pointerup", { bubbles: true }))
  seek.dispatchEvent(new Event("change", { bubbles: true }))
  out.pointerSeekOnce = calls.seek.length === 2 && calls.seek[1] === 25

  unmount()
  out.unmounted = !stage.querySelector(".vctl")

  const liveStage = document.createElement("div")
  document.body.append(liveStage)
  const liveCalls = { seek: 0 }
  const unmountLive = mountControls(
    liveStage,
    {
      getPlayerState: () => 1,
      getDuration: () => 0,
      getCurrentTime: () => 0,
      pauseVideo: () => {},
      playVideo: () => {},
      seekTo: () => (liveCalls.seek += 1),
    },
    { isReplay: () => false, hideMs: 5000 },
  )
  const liveSeek = liveStage.querySelector(".vctl-seek")
  out.liveBadge = liveStage.querySelector(".vctl-live")?.hidden === false
  out.liveSeekHidden = liveSeek.hidden === true && liveSeek.disabled === true
  liveSeek.value = "500"
  liveSeek.dispatchEvent(new Event("change", { bubbles: true }))
  out.liveSeekBlocked = liveCalls.seek === 0
  unmountLive()
  return out
})

await page.evaluate(
  base => globalThis.SYCApp.startLive("VIDEOIDXXXX", base),
  `http://localhost:${port}`,
)
await page.evaluate(() => globalThis.__sycEmitPlayerState(1))
await waitFor(() => apiCalls >= 1)

const afterStart = apiCalls
await page.evaluate(() => {
  globalThis.__sycHidden = true
  document.dispatchEvent(new Event("visibilitychange"))
})
const hiddenAt = apiCalls
await new Promise(done => setTimeout(done, 950))
const hiddenAfter = apiCalls

await page.evaluate(() => {
  globalThis.__sycHidden = false
  document.dispatchEvent(new Event("visibilitychange"))
})
await waitFor(() => apiCalls > hiddenAfter, 2500)
const visibleAfter = apiCalls

await page.evaluate(() => globalThis.__sycEmitPlayerState(2))
const pausedAt = apiCalls
await new Promise(done => setTimeout(done, 950))
const pausedAfter = apiCalls

const listBeforePausedSeek = await page.evaluate(() => globalThis.SYCApp.list.count)
await page.evaluate(() => globalThis.__sycFakePlayer.seekTo(60, true))
await waitFor(() => page.evaluate(() => globalThis.SYCApp.list.count === 0), 2500)
const pausedSeekCleared = await page.evaluate(() => globalThis.SYCApp.list.count === 0)
const pausedSeekAt = apiCalls
await new Promise(done => setTimeout(done, 250))
const pausedSeekAfter = apiCalls

await page.evaluate(() => globalThis.__sycEmitPlayerState(1))
await waitFor(() => apiCalls > pausedSeekAt, 2500)
const playingAfter = apiCalls
const pausedSeekOffset = apiRequests.slice(pausedSeekAt).some(request => request.offset === "60000")

await page.evaluate(() => globalThis.__sycEmitPlayerState(-1))
const unknownAt = apiCalls
await new Promise(done => setTimeout(done, 950))
const unknownAfter = apiCalls

await page.evaluate(() => globalThis.__sycEmitPlayerState(1))
await waitFor(() => apiCalls > unknownAfter, 2500)
const liveBeforeMock = apiCalls

await page.evaluate(() => globalThis.SYCApp.startMockMode())
const mockStatus = await page.textContent("#status")
const mockAt = apiCalls
await new Promise(done => setTimeout(done, 350))
const mockAfter = apiCalls

await page.evaluate(() => globalThis.SYCApp.stop())
const stoppedStatus = await page.textContent("#status")

await browser.close()
close()

const checks = [
  ["control bar built", r.barExists],
  ["fmtTime correct", JSON.stringify(r.fmt) === JSON.stringify(["0:00", "1:05", "1:01:01"])],
  ["tap toggles play", r.tapPlays],
  ["tap toggles pause", r.tapPauses],
  ["play button toggles", r.btnToggles],
  ["seek bar seeks", r.seekSeeks],
  ["pointer seek commits once", r.pointerSeekOnce],
  ["teardown removes overlay", r.unmounted],
  ["live mode shows LIVE badge", r.liveBadge],
  ["live mode hides seekbar", r.liveSeekHidden],
  ["live mode blocks seek commits", r.liveSeekBlocked],
  ["live client starts polling", afterStart >= 1],
  ["visibilitychange hidden pauses polling", hiddenAfter === hiddenAt],
  ["visibilitychange visible resumes polling", visibleAfter > hiddenAfter],
  ["player paused state pauses polling", pausedAfter === pausedAt],
  ["paused seek had rows to clear", listBeforePausedSeek > 0],
  ["paused seek clears views", pausedSeekCleared],
  ["paused seek does not poll until playback resumes", pausedSeekAfter === pausedSeekAt],
  ["paused seek refresh uses new offset", pausedSeekOffset],
  ["player playing state resumes polling", playingAfter > pausedSeekAt],
  ["unknown player state pauses polling", unknownAfter === unknownAt],
  ["mock mode starts", mockStatus === "mock" || mockStatus === "デモ"],
  ["startMockMode stops live polling", mockAfter - mockAt <= 1],
  ["stop updates status", stoppedStatus === "stopped" || stoppedStatus === "停止"],
  ["no page errors", errors.length === 0],
]

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`)
  if (!pass) ok = false
}
if (!ok) {
  console.log(
    "detail:",
    JSON.stringify({
      controls: r,
      apiCalls,
      afterStart,
      hiddenAt,
      hiddenAfter,
      visibleAfter,
      pausedAt,
      pausedAfter,
      listBeforePausedSeek,
      pausedSeekCleared,
      pausedSeekAt,
      pausedSeekAfter,
      pausedSeekOffset,
      apiRequests: apiRequests.slice(-8),
      playingAfter,
      unknownAt,
      unknownAfter,
      liveBeforeMock,
      mockStatus,
      mockAt,
      mockAfter,
      stoppedStatus,
    }),
    errors,
  )
}
console.log(ok ? "RESULT: ✅ custom video controls verified" : "RESULT: ❌ FAIL")
process.exit(ok ? 0 : 1)
