// Playwright test for the custom video controls, driven by a FAKE player (no real
// YouTube): tap toggles play/pause, the play button toggles, the seek bar seeks,
// and teardown removes the overlay.

import { chromium } from "playwright"
import { serveWeb } from "./_serve.mjs"

const { port, close } = await serveWeb()
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on("pageerror", e => errors.push(e.message))

// load any same-origin page so we can dynamically import the module
await page.goto(`http://localhost:${port}/index.html`, { waitUntil: "load" })

const r = await page.evaluate(async () => {
  const { mountControls, fmtTime } = await import("./videoctl.js")

  const calls = { play: 0, pause: 0, seek: null }
  let state = 2 // paused
  const player = {
    getPlayerState: () => state,
    getDuration: () => 100,
    getCurrentTime: () => 30,
    playVideo: () => ((calls.play += 1), (state = 1)),
    pauseVideo: () => ((calls.pause += 1), (state = 2)),
    seekTo: s => (calls.seek = s),
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
  out.seekSeeks = calls.seek === 50 // 500/1000 * duration(100)

  unmount()
  out.unmounted = !stage.querySelector(".vctl")
  return out
})

await browser.close()
close()

const checks = [
  ["control bar built", r.barExists],
  ["fmtTime correct", JSON.stringify(r.fmt) === JSON.stringify(["0:00", "1:05", "1:01:01"])],
  ["tap toggles play", r.tapPlays],
  ["tap toggles pause", r.tapPauses],
  ["play button toggles", r.btnToggles],
  ["seek bar seeks", r.seekSeeks],
  ["teardown removes overlay", r.unmounted],
  ["no page errors", errors.length === 0],
]

let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`)
  if (!pass) ok = false
}
if (!ok) console.log("detail:", JSON.stringify(r), errors)
console.log(ok ? "RESULT: ✅ custom video controls verified" : "RESULT: ❌ FAIL")
process.exit(ok ? 0 : 1)
