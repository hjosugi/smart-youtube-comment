// Thin orchestrator: wires player + chat source + scoring + danmaku + list +
// settings + help. All real logic lives in the small modules it composes.

import { readParams, parseInput } from "./config.ts"
import { makeRenderer } from "./pipeline.ts"
import { makeFate, isSeek } from "./playback.ts"
import { mountPlayer } from "./player.ts"
import { startMock } from "./mock.ts"
import { createWakeLock, setMediaSession } from "./lifecycle.ts"
import { mountSettings, mountHelp } from "./ui.ts"
import { mountPerfHud } from "./perf.ts"
import { mountControls, fmtTime } from "./videoctl.ts"
import { createCommentList } from "./commentlist.ts"
import { createLiveChatClient } from "./chat-client.ts"
import { T, lang, statusText } from "./i18n.ts"
import { sanitizeChatMessage } from "./url-security.ts"
import type { ChatMessage } from "./types.ts"

const { createFallbackScorer, buildRenderPlan } = globalThis.SYCScoring
const { DanmakuOverlay } = globalThis.SYCDanmaku
const settings = globalThis.SYCSettings
const filter = globalThis.SYCFilter

// DOM access is glue — `$` returns `any` so element-shape details stay out of the way.
const $ = (id: string): any => document.getElementById(id)
const setStatus = (key: string) => ($("status").textContent = statusText(key))
const readAppParams = () =>
  readParams(location.search, { trustedRelayOrigins: globalThis.SYC_TRUSTED_RELAY_ORIGINS })

const overlay = new DanmakuOverlay()
const list = createCommentList($("list"))
const render = makeRenderer(createFallbackScorer(), buildRenderPlan)

let cfg: Record<string, any> = settings.DEFAULTS
const applySettings = (s: Record<string, any>) => {
  cfg = s
  overlay.setConfig(settings.toEngineConfig(s))
  list.setVisible(s.listEnabled)
}

let playbackMs = (): number => Infinity

// --- message pipeline: gate once, fan out to danmaku (scored) + list (raw) ---
const seen = new Set<string>()
const remember = (id: string) => {
  if (seen.size > 4000) seen.clear()
  seen.add(id)
}
const fate = makeFate({ seen, shouldDrop: (a: string, t: string) => filter.shouldDrop(a, t) })

const onMessages = (msgs: ChatMessage[]) => {
  const now = playbackMs()
  for (const raw of msgs) {
    const m = sanitizeChatMessage(raw)
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
let activeVideo: string | null = null // currently-playing id; re-submitting must not restart
let seekActive: ((s: number) => void) | null = null // seek the active player on same-video re-submit

const startMockMode = () => {
  overlay.attach($("stage"))
  setStatus("mock")
  const stopMock = startMock(onMessages, { ratePerSec: 30 })
  stop = () => {
    stopMock()
    overlay.detach()
    list.clear()
    setStatus("stopped")
  }
}

const startLive = async (videoId: string, relay: string, startSeconds = 0) => {
  stop()
  if (navigator.onLine === false) {
    activeVideo = null
    seekActive = null
    playbackMs = () => Infinity
    setStatus("offline")
    return
  }
  activeVideo = videoId
  seen.clear()
  setStatus("loading")
  const client = createLiveChatClient({ base: relay, getOffsetMs: () => playbackMs() })

  let playing = false
  let player: any
  try {
    player = await mountPlayer(
      "player",
      videoId,
      (state: string) => {
        playing = state === "playing"
        playing ? client.resume() : client.pause()
      },
      startSeconds,
    )
  } catch {
    client.stop()
    activeVideo = null
    seekActive = null
    playbackMs = () => Infinity
    setStatus("player_error")
    return
  }
  playbackMs = () => (player.getCurrentTime?.() ?? 0) * 1000
  seekActive = (s: number) => player.seekTo?.(s, true)

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
    onState: ({ healthy, failures, replay }: any) =>
      setStatus(healthy || failures < 2 ? (replay ? "replay" : "live") : "reconnecting"),
    onEnded: ({ reason }: any) => setStatus(reason),
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
    setStatus("stopped")
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
$("launch").addEventListener("submit", (e: Event) => {
  e.preventDefault()
  const { video, start } = parseInput($("video").value)
  if (!video) return setStatus("invalid")
  if (video === activeVideo && seekActive) {
    if (start) seekActive(start)
    return
  }
  startLive(video, readAppParams().relay, start)
})

// --- localized labels on the static chrome ---
const localizeChrome = () => {
  const labelButton = (id: string, label: string) => {
    const button = $(id)
    button.title = label
    button.setAttribute("aria-label", label)
  }

  document.documentElement.lang = lang
  $("video").placeholder = T.urlPlaceholder
  $("launch").querySelector("button[type=submit]").textContent = T.play
  labelButton("toggle", T.danmakuToggle)
  labelButton("listToggle", T.listToggle)
  labelButton("settings", T.settings)
  labelButton("help", T.help)
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
  settings.onChange((s: Record<string, any>) => {
    applySettings(s)
    reflectToggles()
  })
  mountSettings({ settings, filter, button: $("settings") })
  mountHelp({ button: $("help") })
  reflectToggles()

  const params = readAppParams()
  if (params.perf) mountPerfHud(overlay)
  if (params.mock) startMockMode()
  else if (params.video) startLive(params.video, params.relay, params.start)
})()

// Exposed for tests / debugging (the bundle hides individual modules).
globalThis.SYCApp = {
  overlay,
  list,
  startMockMode,
  startLive,
  stop: () => stop(),
  videoctl: { mountControls, fmtTime },
}
