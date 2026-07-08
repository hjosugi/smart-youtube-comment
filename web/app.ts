// Thin orchestrator: wires player + chat source + scoring + danmaku + list +
// settings + help. All real logic lives in the small modules it composes.

import { readParams, parseInput } from "./config.ts"
import { makeRenderer, renderBatch } from "./pipeline.ts"
import { makeFate, createSeenTracker, createSeekWatcher } from "./playback.ts"
import { mountPlayer } from "./player.ts"
import { startMock } from "./mock.ts"
import { createWakeLock, resolveYouTubeTitle, setMediaSession } from "./lifecycle.ts"
import { mountSettings, mountHelp } from "./ui.ts"
import { mountPerfHud } from "./perf.ts"
import { mountControls, fmtTime } from "./videoctl.ts"
import { createCommentList } from "./commentlist.ts"
import { mountHistorySuggestions, rememberViewing } from "./history.ts"
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
const render = makeRenderer(createFallbackScorer(), buildRenderPlan)

const addNgUser = async (author: string) => {
  if (!author) return
  const lists = await filter.load()
  await filter.save({ ...lists, users: [...lists.users, author] })
}
const addNgWord = async (word: string) => {
  if (!word) return
  const lists = await filter.load()
  await filter.save({ ...lists, words: [...lists.words, word] })
}
const list = createCommentList($("list"), { onBlockUser: addNgUser, onBlockWord: addNgWord })

let cfg: Record<string, any> = settings.DEFAULTS
const applySettings = (s: Record<string, any>) => {
  cfg = s
  overlay.setConfig(settings.toEngineConfig(s))
  list.setVisible(s.listEnabled)
}

let playbackMs = (): number => Infinity

// --- message pipeline: gate once, fan out to danmaku (scored) + list (raw) ---
const seen = createSeenTracker(4000)
const remember = (id: string) => seen.add(id)
const fate = makeFate({ seen, shouldDrop: (a: string, t: string) => filter.shouldDrop(a, t) })

const onMessages = (msgs: ChatMessage[]) => {
  const now = playbackMs()
  const listBatch: ChatMessage[] = []
  const renderMessages: ChatMessage[] = []
  for (const raw of msgs) {
    const m = sanitizeChatMessage(raw)
    const f = fate(m, now)
    if (f === "skip") continue
    remember(m.id)
    if (f !== "show") continue
    globalThis.SYCEmoji?.preload(m.parts)
    if (cfg.listEnabled) listBatch.push(m)
    if (cfg.enabled) renderMessages.push(m)
  }
  if (listBatch.length) list.pushMany(listBatch)
  if (renderMessages.length) renderBatch(render, overlay, renderMessages)
}

// --- sources ---
const wakeLock = createWakeLock()
let stop = () => {}
let sourceGeneration = 0
let activeVideo: string | null = null // currently-playing id; re-submitting must not restart
let seekActive: ((s: number) => void) | null = null // seek the active player on same-video re-submit
let activeTitle = ""
let historyUi: any = null

const rememberActiveHistory = () => {
  if (!activeVideo) return
  const offsetMs = playbackMs()
  rememberViewing({
    video: activeVideo,
    title: activeTitle || activeVideo,
    positionSeconds: Number.isFinite(offsetMs) ? Math.floor(offsetMs / 1000) : 0,
  })
  historyUi?.render()
}

const startMockMode = () => {
  const generation = (sourceGeneration += 1)
  stop()
  const isCurrent = () => generation === sourceGeneration
  overlay.attach($("stage"))
  setStatus("mock")
  const stopMock = startMock(onMessages, { ratePerSec: 30 })
  stop = () => {
    const wasCurrent = isCurrent()
    if (wasCurrent) sourceGeneration += 1
    stopMock()
    overlay.detach()
    list.clear()
    if (wasCurrent) setStatus("stopped")
  }
}

const startLive = async (videoId: string, relay: string, startSeconds = 0) => {
  const generation = (sourceGeneration += 1)
  stop()
  const isCurrent = () => generation === sourceGeneration
  if (navigator.onLine === false) {
    activeVideo = null
    activeTitle = ""
    seekActive = null
    playbackMs = () => Infinity
    setStatus("offline")
    return
  }
  activeVideo = videoId
  activeTitle = videoId
  seen.clear()
  setStatus("loading")
  const client = createLiveChatClient({ base: relay, getOffsetMs: () => playbackMs() })
  stop = () => {
    const wasCurrent = isCurrent()
    if (wasCurrent) sourceGeneration += 1
    client.stop()
    rememberActiveHistory()
    activeVideo = null
    activeTitle = ""
    seekActive = null
    playbackMs = () => Infinity
    if (wasCurrent) setStatus("stopped")
  }

  let playing = false
  let player: any
  try {
    player = await mountPlayer(
      "player",
      videoId,
      (state: string) => {
        if (!isCurrent()) return
        playing = state === "playing"
        if (playing && !document.hidden) client.resume()
        else client.pause()
      },
      startSeconds,
    )
    if (!isCurrent()) {
      client.stop()
      player.destroy?.()
      return
    }
  } catch {
    client.stop()
    if (isCurrent()) {
      activeVideo = null
      activeTitle = ""
      seekActive = null
      playbackMs = () => Infinity
      setStatus("player_error")
    }
    return
  }
  playbackMs = () => (player.getCurrentTime?.() ?? 0) * 1000
  seekActive = (s: number) => player.seekTo?.(s, true)
  rememberActiveHistory()

  // Seek detection: on a scrub, clear both views, forget shown ids, re-fetch now.
  const seekWatcher = createSeekWatcher({
    playbackMs,
    isPlaying: () => playing,
    onSeek: () => {
      overlay.clear()
      list.clear()
      seen.clear()
      client.refresh()
      rememberActiveHistory()
    },
  })

  const onVisibility = () => (document.hidden || !playing ? client.pause() : client.resume())
  document.addEventListener("visibilitychange", onVisibility)

  overlay.attach($("stage"))
  let replayMode = false
  const unmountCtl = mountControls($("stage"), player, { isReplay: () => replayMode })
  wakeLock.acquire()
  const mediaActions = {
    play: () => player.playVideo?.(),
    pause: () => player.pauseVideo?.(),
    seekbackward: () => player.seekTo?.(Math.max(0, (player.getCurrentTime?.() || 0) - 10), true),
    seekforward: () => player.seekTo?.((player.getCurrentTime?.() || 0) + 10, true),
  }
  setMediaSession({ title: activeTitle, actions: mediaActions })
  void resolveYouTubeTitle(videoId).then(title => {
    if (!isCurrent() || !title) return
    activeTitle = title
    setMediaSession({ title: activeTitle, actions: mediaActions })
    rememberActiveHistory()
  })

  if (!playing || document.hidden) client.pause()
  client.start(videoId, {
    onMessages: (msgs: ChatMessage[]) => {
      if (isCurrent()) onMessages(msgs)
    },
    onState: ({ healthy, failures, replay }: any) => {
      if (!isCurrent()) return
      replayMode = !!replay
      setStatus(healthy || failures < 2 ? (replay ? "replay" : "live") : "reconnecting")
    },
    onEnded: ({ reason }: any) => isCurrent() && setStatus(reason),
  })

  stop = () => {
    const wasCurrent = isCurrent()
    if (wasCurrent) sourceGeneration += 1
    seekWatcher.stop()
    document.removeEventListener("visibilitychange", onVisibility)
    rememberActiveHistory()
    client.stop()
    overlay.detach()
    unmountCtl()
    list.clear()
    wakeLock.release()
    playbackMs = () => Infinity
    activeVideo = null
    activeTitle = ""
    seekActive = null
    player.destroy?.()
    if (wasCurrent) setStatus("stopped")
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
  historyUi = mountHistorySuggestions($("video"))
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
