// Frame-pacing regression probe for the danmaku engine.
//
// Drives the sandbox page in Chromium for a fixed time while recording a
// performance trace, then reports (a) requestAnimationFrame gaps above a frame
// and a half and (b) every major GC pause on the renderer main thread. The
// periodic "jolt" this project shipped with was exactly (b): one <canvas> per
// comment inflated V8's external memory until a full mark-compact ran every
// ~0.5-3 s (10-26 ms pauses). With the sprite atlas the steady state allocates
// nothing, so the major-GC count over a run must stay near zero.
//
// Usage (sandbox server up: npm run sandbox):
//   node bench/jank-trace.mjs                # headless, 12 s at 200 comments/s
//   SYC_HEADED=1 node bench/jank-trace.mjs   # real GPU on the local display
//   SYC_JANK_MAX_GC=2 node bench/jank-trace.mjs   # fail when major GCs exceed 2
//
// Headless Chromium rasterizes in software, so frame rate there is CPU-bound and
// not representative; the GC count is meaningful in both modes.
import { readFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { chromium } = await import("playwright")

const HOST = process.env.SYC_JUDDER_HOST || "http://127.0.0.1:4173"
const url = process.argv[2] || `${HOST}/sandbox/danmaku.html`
const seconds = Number(process.env.SYC_JANK_SECONDS || 12)
const maxGc = process.env.SYC_JANK_MAX_GC == null ? null : Number(process.env.SYC_JANK_MAX_GC)
const headed = process.env.SYC_HEADED === "1"

const browser = await chromium.launch({ headless: !headed })
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: Number(process.env.SYC_DSF || 1.25),
})
const page = await context.newPage()
page.on("pageerror", error => console.log("pageerror:", error.message))
await page.goto(url, { waitUntil: "load" })
await page.waitForTimeout(2000)

await page.evaluate(() => {
  const gaps = []
  let last = 0
  let frames = 0
  const tick = ts => {
    frames++
    if (last) {
      const d = ts - last
      if (d > 25) gaps.push({ t: ts, d })
    }
    last = ts
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  globalThis.__jank = { gaps, frames: () => frames }
})

const tracePath = join(tmpdir(), `syc-jank-${process.pid}.json`)
await browser.startTracing(page, {
  path: tracePath,
  categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "disabled-by-default-v8.gc"],
})
const framesBefore = await page.evaluate(() => globalThis.__jank.frames())
await page.waitForTimeout(seconds * 1000)
await browser.stopTracing()
const framesAfter = await page.evaluate(() => globalThis.__jank.frames())
const gaps = await page.evaluate(() => globalThis.__jank.gaps)
const hud = await page.evaluate(() => {
  const read = id => document.getElementById(id)?.textContent
  return { fps: read("fps"), active: read("active"), pages: read("pages"), p99: read("p99"), max: read("max") }
})
await browser.close()

const events = JSON.parse(readFileSync(tracePath, "utf8")).traceEvents
unlinkSync(tracePath)
const majorGcs = events.filter(e => e.name === "MajorGC" && e.ph === "X")
const totalPauseMs = majorGcs.reduce((sum, e) => sum + e.dur / 1000, 0)
const longest = majorGcs.reduce((m, e) => Math.max(m, e.dur / 1000), 0)

console.log(`frames: ${framesAfter - framesBefore} in ${seconds}s (${((framesAfter - framesBefore) / seconds).toFixed(1)}/s)`)
console.log(`hud: fps=${hud.fps} active=${hud.active} pages=${hud.pages} p99=${hud.p99} max=${hud.max}`)
console.log(`rAF gaps > 25ms: ${gaps.length}${gaps.length ? " (" + gaps.map(g => g.d.toFixed(0) + "ms").join(", ") + ")" : ""}`)
console.log(`major GC pauses: ${majorGcs.length}, total ${totalPauseMs.toFixed(1)}ms, longest ${longest.toFixed(1)}ms`)

if (maxGc != null && majorGcs.length > maxGc) {
  console.log(`FAIL ❌  ${majorGcs.length} major GCs > ${maxGc}`)
  process.exit(1)
}
console.log("PASS ✅")
