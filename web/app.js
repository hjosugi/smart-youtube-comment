// Thin orchestrator: wires player + chat source + scoring + danmaku + list +
// settings + help. All real logic lives in the small modules it composes.

import { readParams, parseInput } from "./config.js"
import { makeRenderer } from "./pipeline.js"
import { makeFate, isSeek } from "./playback.js"
import { mountPlayer } from "./player.js"
import { startMock } from "./mock.js"
import { createWakeLock, setMediaSession } from "./lifecycle.js"
import { mountSettings, mountHelp } from "./ui.js"
import { mountPerfHud } from "./perf.js"
import { mountControls } from "./videoctl.js"
import { createCommentList } from "./commentlist.js"
import { createLiveChatClient } from "./chat-client.js"
import { T, statusText } from "./i18n.js"

const { createFallbackScorer, buildRenderPlan } = globalThis.SYCScoring
const { DanmakuOverlay } = globalThis.SYCDanmaku
const settings = globalThis.SYCSettings
const filter = globalThis.SYCFilter

const $ = id => document.getElementById(id)
const setStatus = key => ($("status").textContent = statusText(key))

const overlay = new DanmakuOverlay()
const list = createCommentList($("list"))
const render = makeRenderer(createFallbackScorer(), buildRenderPlan)

let cfg = settings.DEFAULTS
const applySettings = s => {
  cfg = s
  overlay.setConfig(settings.toEngineConfig(s))
  list.setVisible(s.listEnabled)
}

let playbackMs = () => Infinity

// --- message pipeline: gate once, fan out to danmaku (scored) + list (raw) ---
const seen = new Set()
const remember = id => {
  if (seen.size > 4000) seen.clear()
  seen.add(id)
}
const fate = makeFate({ seen, shouldDrop: (a, t) => filter.shouldDrop(a, t) })

let lastNow = 0
const onMessages = msgs => {
  const now = playbackMs()
  for (const m of msgs) {
    const f = fate(m, now)
    if (f === "skip") continue
    remember(m.id)
    if (f !== "show") continue
    globalThis.SYCEmoji?.preload(m.parts)
    if (cfg.listEnabled) list.push(m)
    if (cfg.enabled) {
      const payload = render(m)
      if (payload) overlay.push(payload)
    }
  }
}

// --- sources ---
const wakeLock = createWakeLock()
let stop = () => {}
let activeVideo = null // currently-playing id; re-submitting it must not restart
let seekActive = null // seek the active player (used on same-video re-submit)

const startMockMode = () => {
  overlay.attach($("stage"))
  setStatus("mock")
  const stopMock = startMock(onMessages, { ratePerSec: 30 })
  stop = () => {
    stopMock()
    overlay.detach()
    list.clear()
  }
}

const startLive = async (videoId, relay, startSeconds = 0) => {
  stop()
  activeVideo = videoId
  seen.clear()
  setStatus("loading")
  const client = createLiveChatClient({ base: relay, getOffsetMs: () => playbackMs() })

  let playing = false
  const player = await mountPlayer(
    "player",
    videoId,
    state => {
      playing = state === "playing"
      playing ? client.resume() : client.pause()
    },
    startSeconds,
  )
  playbackMs = () => (player.getCurrentTime?.() ?? 0) * 1000
  seekActive = s => player.seekTo?.(s, true)

  // Seek detection: on a scrub, clear both views, forget shown ids, re-fetch now.
  let lastT = playbackMs()
  let lastWall = performance.now()
  const seekTimer = setInterval(() => {
    const t = playbackMs()
    const wall = performance.now()
    if (playing && isSeek(t - lastT, wall - lastWall)) {
      overlay.clear()
      list.clear()
      seen.clear()
      client.refresh()
    }
    lastT = t
    lastWall = wall
  }, 700)

  const onVisibility = () => (document.hidden ? client.pause() : client.resume())
  document.addEventListener("visibilitychange", onVisibility)

  overlay.attach($("stage"))
  const unmountCtl = mountControls($("stage"), player)
  wakeLock.acquire()
  setMediaSession({ title: videoId })

  client.start(videoId, {
    onMessages,
    onState: ({ healthy, failures, replay }) =>
      setStatus(healthy || failures < 2 ? (replay ? "replay" : "live") : "reconnecting"),
    onEnded: ({ reason }) => setStatus(reason),
  })

  stop = () => {
    clearInterval(seekTimer)
    document.removeEventListener("visibilitychange", onVisibility)
    client.stop()
    overlay.detach()
    unmountCtl()
    list.clear()
    wakeLock.release()
    playbackMs = () => Infinity
    activeVideo = null
    seekActive = null
    player.destroy?.()
  }
}

// --- toggles: 💬 danmaku, 📋 comment list (both persist via settings) ---
const reflectToggles = () => {
  $("toggle").classList.toggle("off", !cfg.enabled)
  $("toggle").setAttribute("aria-pressed", String(cfg.enabled))
  $("listToggle").classList.toggle("off", !cfg.listEnabled)
  $("listToggle").setAttribute("aria-pressed", String(cfg.listEnabled))
}
$("toggle").addEventListener("click", () => settings.save({ ...cfg, enabled: !cfg.enabled }))
$("listToggle").addEventListener("click", () =>
  settings.save({ ...cfg, listEnabled: !cfg.listEnabled }),
)

// --- launch form: same video re-submit seeks (no restart); honor &t= start ---
$("launch").addEventListener("submit", e => {
  e.preventDefault()
  const { video, start } = parseInput($("video").value)
  if (!video) return setStatus("invalid")
  if (video === activeVideo && seekActive) {
    if (start) seekActive(start)
    return
  }
  startLive(video, readParams(location.search).relay, start)
})

// --- localized labels on the static chrome ---
const localizeChrome = () => {
  $("video").placeholder = T.urlPlaceholder
  $("launch").querySelector("button[type=submit]").textContent = T.play
  $("toggle").title = T.danmakuToggle
  $("listToggle").title = T.listToggle
  $("settings").title = T.settings
  $("help").title = T.help
  setStatus("idle")
}

// --- init ---
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}))
}

;(async () => {
  localizeChrome()
  applySettings(await settings.load())
  await filter.load()
  settings.onChange(s => {
    applySettings(s)
    reflectToggles()
  })
  mountSettings({ settings, filter, button: $("settings") })
  mountHelp({ button: $("help") })
  reflectToggles()

  const params = readParams(location.search)
  if (params.perf) mountPerfHud(overlay)
  if (params.mock) startMockMode()
  else if (params.video) startLive(params.video, params.relay, params.start)
})()

// Exposed for tests / debugging.
globalThis.SYCApp = { overlay, list, startMockMode, startLive, stop: () => stop() }
