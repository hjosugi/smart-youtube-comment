// Frame-pacing probe on a REAL YouTube live page with the unpacked extension.
//
// The sandbox (bench/jank-trace.mjs) cannot show presentation-side misses: on a
// real watch page the renderer's commit pipeline is back-pressured by the
// display, and YouTube's own main thread runs 0.5 s tasks. This loads the
// extension into headed Chromium on the local GPU, opens a live stream, injects
// a steady synthetic comment stream into the stage frame (where the engine
// runs), records a trace and reports the stage's frame gaps, missed vsyncs,
// display swaps that took more than one interval, per-thread busy time for the
// YouTube renderer, the stage and the GPU process, and GPU busy (AMD sysfs).
//
// "Stage frames" are the frames that move the comments: compositor draws of
// the stage process for the default compositor renderer (no script runs per
// frame there), requestAnimationFrame callbacks for the canvas renderer.
//
// "Presented" is the number that matches what the eye sees. It counts, for
// every display frame, how many new frames of the stage's surface had arrived:
// 1 is a fresh frame, 0 is the previous one held for another vsync, 2 means a
// frame was never shown. A renderer can run its frame callback on every vsync
// and still be held and skipped several times a second when its frames reach
// the display compositor out of step with it; frame gaps cannot show that.
//
// "held by cause" says why. The display compositor announces every frame with
// a BeginFrame and waits for its clients until the deadline that BeginFrame
// names. On a display whose clock is irregular (a remote-desktop virtual
// monitor is one) some BeginFrames come with almost no time left, and frames
// held there say nothing about the renderer. Compare renderers on the other
// two causes, and read the "display BeginFrames" line before trusting "held".
//
//   DISPLAY=:0 node bench/real-page-trace.mjs                # X11 (XWayland)
//   SYC_WAYLAND=1 node bench/real-page-trace.mjs             # native Wayland (Chrome >= 140 default)
//   SYC_URL=https://www.youtube.com/watch?v=... SYC_SECONDS=12 SYC_SYNTH_RATE=20 node bench/real-page-trace.mjs
//   SYC_BROWSER=/opt/brave-bin/brave SYC_SYNTH_RATE=0 SYC_MODE=fullscreen ...  # real chat only, another Chromium
//   SYC_TRACE_OUT=trace.json ...                             # keep the raw trace for hitch attribution
//   SYC_HEADLESS=1 ...                                        # no window; main-thread load is valid, frame pacing is not
//   SYC_RENDERER=canvas ...                                   # the canvas renderer instead of the default compositor one
//   SYC_SETTINGS='{"outlineWidth":0}' ...                     # any other settings to apply first
//   SYC_EXTENSION_DIR=/path/to/other/extension ...            # another build of the extension, for an A/B in one session
//   SYC_WINDOW_SIZE=2856,1461 ...                             # window size in px (default 1920,1080)
//
// Numbers to expect on a healthy build (12 s, 20 comments/s): missed vsyncs in
// the low single digits and BeginMainFrame on the YouTube main thread well
// below 60/s; see docs/PERFORMANCE.md "Stage Frame".
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

const { chromium } = await import("playwright")

const EXT = process.env.SYC_EXTENSION_DIR
  ? resolvePath(process.env.SYC_EXTENSION_DIR)
  : fileURLToPath(new URL("../extension", import.meta.url))
const url = process.env.SYC_URL || "https://www.youtube.com/watch?v=coYw-eVU0Ks"
const seconds = Number(process.env.SYC_SECONDS || 12)
const synthRate = Number(process.env.SYC_SYNTH_RATE || 20)
const settleMs = Number(process.env.SYC_SETTLE_MS || 20000)
const wayland = process.env.SYC_WAYLAND === "1"
const headless = process.env.SYC_HEADLESS === "1" // CPU-side numbers only: no real display or vsync
const gpuBusyPath = process.env.SYC_GPU_BUSY || "/sys/class/drm/card1/device/gpu_busy_percent"
const mode = process.env.SYC_MODE || "theater" // theater | fullscreen | default
const traceOut = process.env.SYC_TRACE_OUT
const renderer = process.env.SYC_RENDERER === "canvas" ? "canvas" : "compositor"

const profile = mkdtempSync(join(tmpdir(), "syc-real-page-"))
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  executablePath: process.env.SYC_BROWSER || undefined,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-sandbox",
    `--window-size=${process.env.SYC_WINDOW_SIZE || "1920,1080"}`,
    "--autoplay-policy=no-user-gesture-required",
    ...(wayland ? ["--ozone-platform=wayland"] : []),
    ...(headless ? ["--headless=new", "--use-gl=angle", "--use-angle=gl-egl"] : []), // hardware GL
  ],
})
try {
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 })
  const extId = new URL(sw.url()).host
  await sw.evaluate(
    async overrides => {
      const key = "syc:settings"
      const got = await chrome.storage.sync.get(key)
      await chrome.storage.sync.set({ [key]: { ...got[key], ...overrides } })
    },
    { ...JSON.parse(process.env.SYC_SETTINGS || "{}"), renderer },
  )

  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
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
  if (mode === "theater" && !theater) await page.keyboard.press("t")
  if (mode === "fullscreen") await page.keyboard.press("f")
  await page.waitForSelector(".syc-danmaku-canvas", { timeout: 30000 }) // the stage frame
  await page.waitForTimeout(settleMs) // let YouTube finish its initial quality switch

  // The engine lives in the stage frame (stage.html), not in the page.
  const stage = page.frames().find(frame => frame.url().startsWith("chrome-extension://"))
  if (!stage) throw new Error(`stage frame not found (extension ${extId})`)
  const inOverlay = expression => stage.evaluate(expression)
  await inOverlay(`(() => {
    const o = globalThis.__sycOverlay
    const m = globalThis.__m = { tsDelta: [], loopMs: [], lastTs: 0, pushed: 0 }
    const realLoop = o._loop
    o._loop = function (ts) {
      const t0 = performance.now()
      if (m.lastTs) m.tsDelta.push(ts - m.lastTs)
      m.lastTs = ts
      realLoop.call(this, ts)
      m.loopMs.push(performance.now() - t0)
    }
    const realPush = o.push
    o.push = function (payload) {
      m.pushed++
      return realPush.call(this, payload)
    }
    const SAMPLE = ["草", "w", "POG", "それな", "優勝", "かわいい", "nice play", "what song is this",
      "聞こえてますよ配信お疲れ様です", "thanks for the explanation that really helped me understand it"]
    let n = 0
    if (${synthRate} > 0) m.timer = setInterval(() => {
      for (let k = 0; k < Math.max(1, Math.round(${synthRate} / 10)); k++) {
        const t = SAMPLE[n % SAMPLE.length] + " #" + n++
        o.push({ text: t, parts: [{ t }], tier: 1, durationMs: 5000, score: 0.3, emphasis: 0.2, authorType: "normal", kind: "text" })
      }
    }, 100)
    return true
  })()`)
  // No rAF probe in the page: a page-side rAF would itself make YouTube run its
  // lifecycle every vsync. The stage's own frame gaps measure smoothness.
  await inOverlay("globalThis.__m.tsDelta.length = 0")

  const events = []
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value))
  const complete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve))
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      recordMode: "recordContinuously",
      includedCategories: [
        "toplevel",
        "benchmark",
        "viz",
        "cc",
        "disabled-by-default-devtools.timeline.frame",
        ...(traceOut ? ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "blink", "gpu"] : []),
      ],
    },
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

  const m = await inOverlay(`(() => { const m = globalThis.__m; clearInterval(m.timer); const o = globalThis.__sycOverlay; return { tsDelta: m.tsDelta, loopMs: m.loopMs, pushed: m.pushed, stats: o.stats(), surface: o.canvas ? "canvas " + o.canvas.width + "x" + o.canvas.height + " desynchronized=" + o.ctx.getContextAttributes().desynchronized : "layer " + o.w + "x" + o.h } })()`)
  if (traceOut) writeFileSync(traceOut, JSON.stringify(events))

  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b)
    return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : 0
  }
  const pname = new Map()
  const tname = new Map()
  for (const e of events) {
    if (e.ph !== "M") continue
    if (e.name === "process_name") pname.set(e.pid, e.args.name)
    if (e.name === "thread_name") tname.set(`${e.pid}:${e.tid}`, e.args.name)
  }
  const gpuPid = [...pname].find(([, n]) => n === "GPU Process")?.[0]
  const swaps = events.filter(e => e.pid === gpuPid && e.name === "Display::DrawAndSwap" && e.ph === "X").sort((a, b) => a.ts - b.ts)
  let slowSwaps = 0
  for (let i = 1; i < swaps.length; i++) if (swaps[i].ts - swaps[i - 1].ts > 25000) slowSwaps++
  // The compositor renderer's comments are moved by the stage's compositor
  // thread: its draws are the frames. The canvas renderer's are its rAF frames.
  const stagePid = [...pname].find(([, n]) => n === "Extension Renderer")?.[0]
  const draws = events
    .filter(e => e.pid === stagePid && e.name === "ProxyImpl::ScheduledActionDraw" && e.ph === "X")
    .map(e => e.ts / 1000)
    .sort((a, b) => a - b)
  const gaps = renderer === "compositor" ? draws.slice(1).map((ts, i) => ts - draws[i]) : m.tsDelta
  const missed = gaps.reduce((sum, g) => sum + Math.max(0, Math.round(g / 16.667) - 1), 0)

  // Presented cadence. The stage submits its frames either as compositor frames
  // or, for a desynchronized canvas, straight from the canvas. Its surface is
  // the one whose activations in the display compositor follow those submits.
  const submits = events
    .filter(
      e =>
        e.pid === stagePid &&
        e.ph === "X" &&
        (e.name === "CanvasResourceDispatcher::DispatchFrame" ||
          (e.name === "Graphics.Pipeline" && e.args?.chrome_graphics_pipeline?.step === "STEP_SUBMIT_COMPOSITOR_FRAME")),
    )
    .map(e => e.ts)
    .sort((a, b) => a - b)
  const sinks = new Map()
  for (const e of events) {
    if (e.name !== "Surface::ActivateFrame" || e.ph !== "X") continue
    const id = /FrameSinkId\((\d+, \d+)\)/.exec(e.args?.SurfaceId || "")?.[1]
    if (!id) continue
    if (!sinks.has(id)) sinks.set(id, [])
    sinks.get(id).push(e.ts)
  }
  const lowerBound = (list, value) => {
    let lo = 0, hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid] < value) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  let stageSink = null
  for (const [id, list] of sinks) {
    list.sort((a, b) => a - b)
    const followed = submits.filter(ts => (list[lowerBound(list, ts)] ?? Infinity) - ts < 5000).length
    const score = submits.length ? followed / submits.length : 0
    if (list.length > 30 && (!stageSink || score > stageSink.score)) stageSink = { id, list, score }
  }
  const displayDraws = swaps.map(e => e.ts)
  const presented = [0, 0, 0]
  if (stageSink) {
    for (let i = 1; i < displayDraws.length; i++) {
      const n = lowerBound(stageSink.list, displayDraws[i]) - lowerBound(stageSink.list, displayDraws[i - 1])
      presented[Math.min(n, 2)]++
    }
  }
  const share = n => ((100 * n) / Math.max(1, presented[0] + presented[1] + presented[2])).toFixed(1)

  // Why a frame was held: the display gave no time (a BeginFrame with under
  // 3 ms to its deadline, or a late display draw next to it), a stage
  // main-thread frame was running, or neither.
  const displayBegin = events
    .filter(e => e.pid === gpuPid && e.name === "DisplayScheduler::BeginFrame" && e.args?.args)
    .sort((a, b) => a.ts - b.ts)
  const shortNotice = displayBegin.filter(e => e.args.args.deadline_us - e.args.now < 3000).map(e => e.ts)
  const upTo = (list, value) => lowerBound(list, value + 0.5) // entries <= value
  const stageMain = [...tname].find(([key, n]) => n === "CrRendererMain" && Number(key.split(":")[0]) === stagePid)?.[0]
  const mainFrames = events.filter(e => `${e.pid}:${e.tid}` === stageMain && e.name === "ProxyMain::BeginMainFrame" && e.ph === "X")
  const heldBy = { display: 0, main: 0, other: 0 }
  if (stageSink) {
    const late = j => j >= 1 && j < displayDraws.length && displayDraws[j] - displayDraws[j - 1] > 25000
    for (let i = 1; i < displayDraws.length; i++) {
      const lo = displayDraws[i - 1], hi = displayDraws[i]
      if (lowerBound(stageSink.list, hi) - lowerBound(stageSink.list, lo) !== 0) continue
      if (upTo(shortNotice, hi) > upTo(shortNotice, lo) || late(i - 1) || late(i) || late(i + 1)) heldBy.display++
      else if (mainFrames.some(e => e.ts < hi && e.ts + e.dur > lo)) heldBy.main++
      else heldBy.other++
    }
  }
  const covered = displayDraws.length > 1 ? (displayDraws.at(-1) - displayDraws[0]) / 1e6 : seconds

  // Busy time per thread = outermost trace slices; BeginMainFrame counts lifecycles.
  const threads = new Map()
  for (const e of events) {
    if (e.ph !== "X" || e.dur == null) continue
    const key = `${e.pid}:${e.tid}`
    let list = threads.get(key)
    if (!list) threads.set(key, (list = []))
    list.push(e)
  }
  const busy = key => {
    const list = (threads.get(key) || []).sort((a, b) => a.ts - b.ts || b.dur - a.dur)
    let end = 0, sum = 0, frames = 0
    for (const e of list) {
      if (e.ts >= end) {
        sum += e.dur
        end = e.ts + e.dur
      }
      if (e.name === "ProxyMain::BeginMainFrame") frames++
    }
    return `${Math.round(sum / 1000 / seconds)} ms/s${frames ? `, BeginMainFrame ${Math.round(frames / seconds)}/s` : ""}`
  }
  const thread = (process, name) => [...tname].find(([key, n]) => n === name && pname.get(Number(key.split(":")[0])) === process)?.[0]

  console.log(`platform: ${wayland ? "wayland" : "x11"}  mode ${mode}  renderer ${renderer}  ${m.surface}  active=${m.stats.active}  pushed ${m.pushed} in ${seconds}s`)
  console.log(`stage frames (${renderer === "compositor" ? "compositor draws" : "rAF"}): ${gaps.length} in ${seconds}s, p50 ${pct(gaps, 0.5)} ms, p99 ${pct(gaps, 0.99)} ms, max ${pct(gaps, 1)} ms`)
  console.log(`missed vsyncs: ${missed} (frame gaps > 25 ms: ${gaps.filter(g => g > 25).length})`)
  console.log(`script per frame: ${m.loopMs.length} frames ran script in ${seconds}s, p99 ${pct(m.loopMs, 0.99)} ms, max ${pct(m.loopMs, 1)} ms`)
  console.log(
    stageSink
      ? `presented (stage surface ${stageSink.id}, ${stageSink.list.length} frames): fresh ${share(presented[1])}%  held ${share(presented[0])}% (${presented[0]})  skipped ${share(presented[2])}% (${presented[2]})`
      : "presented: stage surface not found in the trace",
  )
  if (stageSink) console.log(`held by cause: display clock ${heldBy.display}, during a stage main-thread frame ${heldBy.main}, other ${heldBy.other}`)
  console.log(`display swaps: ${swaps.length}, ${slowSwaps} took more than one interval`)
  if (displayBegin.length) {
    console.log(
      `display BeginFrames: ${(displayBegin.length / covered).toFixed(1)}/s for ${(swaps.length / covered).toFixed(1)} draws/s, ` +
        `${Math.round((100 * shortNotice.length) / displayBegin.length)}% with under 3 ms to their deadline`,
    )
  }
  if (covered < seconds * 0.9) console.log(`warning: the trace covers ${covered.toFixed(1)} s of ${seconds} s (its buffer wrapped); per-second figures below are too low`)
  console.log(`YouTube main thread: ${busy(thread("Renderer", "CrRendererMain"))}`)
  console.log(`stage main thread: ${busy(thread("Extension Renderer", "CrRendererMain"))}`)
  console.log(`GPU main / viz: ${busy(thread("GPU Process", "CrGpuMain"))} / ${busy(thread("GPU Process", "VizCompositorThread"))}`)
  console.log(`gpu busy: avg ${Math.round(gpu.reduce((a, b) => a + b, 0) / Math.max(1, gpu.length))}%, max ${Math.max(0, ...gpu)}%`)
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
