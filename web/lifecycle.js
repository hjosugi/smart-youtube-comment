// Mobile lifecycle helpers — Wake Lock + Media Session. Both degrade gracefully
// when the API is absent (older browsers, non-secure contexts, Node), so they are
// safe to call unconditionally. See ARCHITECTURE.md §2 (no background playback;
// we only keep the screen awake while in the foreground).

const hasNavigator = typeof navigator !== "undefined"

// Keep the screen awake while watching. Browsers auto-release the lock when the
// page is hidden, so we re-acquire on returning to the foreground.
export const createWakeLock = () => {
  const supported = hasNavigator && "wakeLock" in navigator
  let sentinel = null

  const acquire = async () => {
    if (!supported || sentinel) return
    try {
      sentinel = await navigator.wakeLock.request("screen")
      sentinel.addEventListener?.("release", () => (sentinel = null))
    } catch {
      sentinel = null
    }
  }

  const release = async () => {
    try {
      await sentinel?.release?.()
    } finally {
      sentinel = null
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") acquire()
    })
  }

  return {
    acquire,
    release,
    supported,
    get active() {
      return !!sentinel
    },
  }
}

// Show metadata/controls on the lock screen. (Playback continuation itself is not
// guaranteed in the IFrame embed — see ARCHITECTURE.md §2.)
export const setMediaSession = (meta = {}) => {
  if (!hasNavigator || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") {
    return false
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: meta.title ?? "Live",
    artist: meta.artist ?? "Smart YouTube Comment",
    artwork: meta.artwork ?? [{ src: "icons/icon128.png", sizes: "128x128", type: "image/png" }],
  })
  return true
}
