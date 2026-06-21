// Custom video controls over the YouTube IFrame (embedded with controls=0), to
// match an app-like feel: tap the screen to play/pause, a seek bar + time that
// appear on tap/hover and auto-hide after a (configurable, longer) delay. Drives
// the player through the IFrame API. Degrades safely if API methods are missing.

const PLAYING = 1 // YT.PlayerState.PLAYING

export const fmtTime = secs => {
  const s = Math.max(0, Math.floor(secs || 0))
  const m = Math.floor(s / 60)
  const sec = String(s % 60).padStart(2, "0")
  const h = Math.floor(m / 60)
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

const el = (tag: string, cls: string, props: any = {}): any =>
  Object.assign(document.createElement(tag), { className: cls, ...props })

const ICON_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'

export const mountControls = (stage, player, { hideMs = 3500 } = {}) => {
  const wrap = el("div", "vctl")
  const bar = el("div", "vctl-bar")
  const playBtn = el("button", "vctl-play", { type: "button", innerHTML: ICON_PLAY })
  const cur = el("span", "vctl-time", { textContent: "0:00" })
  const dur = el("span", "vctl-time", { textContent: "0:00" })
  const seek = el("input", "vctl-seek", { type: "range", min: "0", max: "1000", value: "0" })
  bar.append(playBtn, cur, seek, dur)
  wrap.append(bar)
  stage.append(wrap)

  const isPlaying = () => player.getPlayerState?.() === PLAYING
  const duration = () => player.getDuration?.() || 0
  let hideTimer: any = null
  let scrubbing = false

  const setIcon = () => (playBtn.innerHTML = isPlaying() ? ICON_PAUSE : ICON_PLAY)
  const show = () => {
    wrap.classList.add("show")
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => scrubbing || wrap.classList.remove("show"), hideMs)
  }
  const toggle = () => {
    isPlaying() ? player.pauseVideo?.() : player.playVideo?.()
    setIcon()
    show()
  }

  // Tap the video area (not the bar) -> play/pause. Hover -> reveal.
  wrap.addEventListener("click", e => {
    if (e.target.closest(".vctl-bar")) return
    toggle()
  })
  wrap.addEventListener("mousemove", show)
  bar.addEventListener("click", e => e.stopPropagation())
  playBtn.addEventListener("click", toggle)

  // Scrub: drag the seek bar, commit on release.
  const previewSeek = () => (cur.textContent = fmtTime((seek.value / 1000) * duration()))
  const commitSeek = () => {
    player.seekTo?.((seek.value / 1000) * duration(), true)
    scrubbing = false
    show()
  }
  seek.addEventListener("pointerdown", () => {
    scrubbing = true
    show()
  })
  seek.addEventListener("input", previewSeek)
  seek.addEventListener("change", commitSeek)
  seek.addEventListener("pointerup", commitSeek)

  const tick = setInterval(() => {
    setIcon()
    dur.textContent = fmtTime(duration())
    if (scrubbing) return
    const d = duration()
    const t = player.getCurrentTime?.() || 0
    if (d > 0) seek.value = String(Math.round((t / d) * 1000))
    cur.textContent = fmtTime(t)
  }, 500)

  show()
  return () => {
    clearInterval(tick)
    clearTimeout(hideTimer)
    wrap.remove()
  }
}
