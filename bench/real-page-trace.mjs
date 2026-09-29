// Frame-pacing probe on a REAL YouTube live page with the unpacked extension.
//
// The sandbox (bench/jank-trace.mjs) cannot show presentation-side misses: on a
// real watch page the renderer's commit pipeline is back-pressured by the
// display, so vsyncs are missed while the main thread is idle. This loads the
// extension into headed Chromium on the local GPU, opens a live stream, injects
// a steady synthetic comment stream into the content-script world, records a
// light compositor trace and reports rAF gaps, missed vsyncs, display swaps
// that took more than one interval, and GPU busy (AMD sysfs) over the window.
//
//   DISPLAY=:0 node bench/real-page-trace.mjs                # X11 (XWayland)
//   SYC_WAYLAND=1 node bench/real-page-trace.mjs             # native Wayland (Chrome >= 140 default)
//   SYC_URL=https://www.youtube.com/watch?v=... SYC_SECONDS=12 SYC_SYNTH_RATE=20 node bench/real-page-trace.mjs
//
// Numbers to expect on a healthy build (12 s, 20 comments/s): missed vsyncs in
// the low single digits; see docs/PERFORMANCE.md "Presentation-Side Misses".
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const { chromium } = await import("playwright")

const EXT = fileURLToPath(new URL("../extension", import.meta.url))
const url = process.env.SYC_URL || "https://www.youtube.com/watch?v=coYw-eVU0Ks"
const seconds = Number(process.env.SYC_SECONDS || 12)
const synthRate = Number(process.env.SYC_SYNTH_RATE || 20)
const settleMs = Number(process.env.SYC_SETTLE_MS || 20000)
const wayland = process.env.SYC_WAYLAND === "1"
const gpuBusyPath = process.env.SYC_GPU_BUSY || "/sys/class/drm/card1/device/gpu_busy_percent"

const profile = mkdtempSync(join(tmpdir(), "syc-real-page-"))
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-sandbox",
    "--window-size=1920,1080",
    "--autoplay-policy=no-user-gesture-required",
    ...(wayland ? ["--ozone-platform=wayland"] : []),
  ],
})
try {
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 })
  const extId = new URL(sw.url()).host

  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Runtime.enable")
  const contexts = []
  cdp.on("Runtime.executionContextCreated", ({ context: created }) => contexts.push(created))
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 })
  await page.waitForTimeout(6000)
  await page.evaluate(() => {
    const v = document.querySelector("video")
    if (v) {
      v.muted = true
      v.play().catch(() => {})
    }
  })
  await page.mouse.move(600, 400)
  const theater = await page.evaluate(() => document.querySelector("ytd-watch-flexy")?.hasAttribute("theater"))
  if (!theater) await page.keyboard.press("t")
  await page.waitForSelector(".syc-danmaku-canvas", { timeout: 30000 })
  await page.waitForTimeout(settleMs) // let YouTube finish its initial quality switch

  // The overlay lives in the content script's isolated world.
  let overlayCtx = null
  for (const c of contexts) {
    if (c.auxData?.type !== "isolated") continue
    const r = await cdp
      .send("Runtime.evaluate", { contextId: c.id, expression: "typeof globalThis.__sycOverlay", returnByValue: true })
      .catch(() => null)
    if (r?.result.value === "object") {
      overlayCtx = c
      break
    }
  }
  if (!overlayCtx) throw new Error(`overlay not found (extension ${extId})`)
  const inOverlay = async expression => {
    const r = await cdp.send("Runtime.evaluate", { contextId: overlayCtx.id, expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  await inOverlay(`(() => {
    const o = globalThis.__sycOverlay
    const m = globalThis.__m = { tsDelta: [], loopMs: [], lastTs: 0 }
    const realLoop = o._loop
    o._loop = function (ts) {
      const t0 = performance.now()
      if (m.lastTs) m.tsDelta.push(ts - m.lastTs)
      m.lastTs = ts
      realLoop.call(this, ts)
      m.loopMs.push(performance.now() - t0)
    }
    const SAMPLE = ["草", "w", "POG", "それな", "優勝", "かわいい", "nice play", "what song is this",
      "聞こえてますよ配信お疲れ様です", "thanks for the explanation that really helped me understand it"]
    let n = 0
    m.timer = setInterval(() => {
      for (let k = 0; k < Math.max(1, Math.round(${synthRate} / 10)); k++) {
        const t = SAMPLE[n % SAMPLE.length] + " #" + n++
        o.push({ text: t, parts: [{ t }], tier: 1, durationMs: 5000, score: 0.3, emphasis: 0.2, authorType: "normal", kind: "text" })
      }
    }, 100)
    return true
  })()`)
  await page.evaluate(() => {
    const g = (globalThis.__gaps = [])
    let last = 0
    const tick = ts => {
      if (last) g.push(ts - last)
      last = ts
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const events = []
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value))
  const complete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve))
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: { recordMode: "recordContinuously", includedCategories: ["benchmark", "viz", "disabled-by-default-devtools.timeline.frame"] },
  })
  const gpu = []
  const gpuTimer = setInterval(() => {
    try {
      gpu.push(Number(readFileSync(gpuBusyPath, "utf8")))
    } catch {}
  }, 250)
  await page.waitForTimeout(seconds * 1000)
  clearInterval(gpuTimer)
  await cdp.send("Tracing.end")
  await complete

  const gaps = await page.evaluate(() => globalThis.__gaps)
  const m = await inOverlay(`(() => { const m = globalThis.__m; clearInterval(m.timer); const o = globalThis.__sycOverlay; return { tsDelta: m.tsDelta, loopMs: m.loopMs, stats: o.stats(), backing: [o.canvas.width, o.canvas.height], desynchronized: o.ctx.getContextAttributes().desynchronized } })()`)

  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b)
    return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : 0
  }
  const pname = new Map()
  for (const e of events) if (e.ph === "M" && e.name === "process_name") pname.set(e.pid, e.args.name)
  const gpuPid = [...pname].find(([, n]) => n === "GPU Process")?.[0]
  const swaps = events.filter(e => e.pid === gpuPid && e.name === "Display::DrawAndSwap" && e.ph === "X").sort((a, b) => a.ts - b.ts)
  let slowSwaps = 0
  for (let i = 1; i < swaps.length; i++) if (swaps[i].ts - swaps[i - 1].ts > 25000) slowSwaps++
  const missed = gaps.reduce((sum, g) => sum + Math.max(0, Math.round(g / 16.667) - 1), 0)

  console.log(`platform: ${wayland ? "wayland" : "x11"}  canvas ${m.backing.join("x")} desynchronized=${m.desynchronized}  active=${m.stats.active}`)
  console.log(`rAF: ${gaps.length} frames in ${seconds}s, p50 ${pct(gaps, 0.5)} ms, p99 ${pct(gaps, 0.99)} ms, max ${pct(gaps, 1)} ms`)
  console.log(`missed vsyncs: ${missed} (rAF gaps > 25 ms: ${gaps.filter(g => g > 25).length})`)
  console.log(`frame loop: p99 ${pct(m.loopMs, 0.99)} ms, max ${pct(m.loopMs, 1)} ms`)
  console.log(`display swaps: ${swaps.length}, ${slowSwaps} took more than one interval`)
  console.log(`gpu busy: avg ${Math.round(gpu.reduce((a, b) => a + b, 0) / Math.max(1, gpu.length))}%, max ${Math.max(0, ...gpu)}%`)
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
