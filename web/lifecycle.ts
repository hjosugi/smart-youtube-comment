// Mobile lifecycle helpers — Wake Lock + Media Session. Both degrade gracefully
// when the API is absent (older browsers, non-secure contexts, Node), so they are
// safe to call unconditionally. See ARCHITECTURE.md §2 (no background playback;
// we only keep the screen awake while in the foreground).

const hasNavigator = typeof navigator !== "undefined"

// Keep the screen awake while watching. Browsers auto-release the lock when the
// page is hidden, so we re-acquire on returning to the foreground.
export const createWakeLock = () => {
  const supported = hasNavigator && "wakeLock" in navigator
  let sentinel: any = null
  let pending = false
  let wanted = false

  const acquire = async () => {
    wanted = true
    if (!supported || sentinel || pending) return
    pending = true
    try {
      const next = await navigator.wakeLock.request("screen")
      if (!wanted) {
        await next.release?.()
        return
      }
      sentinel = next
      sentinel.addEventListener?.("release", () => {
        if (sentinel === next) sentinel = null
      })
    } catch {
      sentinel = null
    } finally {
      pending = false
    }
  }

  const release = async () => {
    wanted = false
    const current = sentinel
    sentinel = null
    try {
      await current?.release?.()
    } catch {}
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (wanted && document.visibilityState === "visible") acquire()
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
const clearMediaAction = (session: any, action: string) => {
  try {
    session.setActionHandler?.(action, null)
  } catch {}
}

export const setMediaSession = (meta: any = {}) => {
  if (!hasNavigator || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") {
    return false
  }
  const session: any = navigator.mediaSession
  session.metadata = new MediaMetadata({
    title: meta.title ?? "Live",
    artist: meta.artist ?? "Smart YouTube Comment",
    artwork: meta.artwork ?? [{ src: "icons/icon128.png", sizes: "128x128", type: "image/png" }],
  })
  const actions = meta.actions || {}
  for (const action of ["play", "pause", "seekbackward", "seekforward"]) {
    if (typeof actions[action] === "function") {
      try {
        session.setActionHandler?.(action, actions[action])
      } catch {}
    } else {
      clearMediaAction(session, action)
    }
  }
  return true
}

export const resolveYouTubeTitle = async (
  videoId: string,
  { fetchImpl = globalThis.fetch, timeoutMs = 3500 } = {},
) => {
  if (!videoId || typeof fetchImpl !== "function") return ""
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    const url = new URL("https://www.youtube.com/oembed")
    url.searchParams.set("format", "json")
    url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`)
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
    if (!res?.ok) return ""
    const body = await res.json().catch(() => null)
    return typeof body?.title === "string" ? body.title.trim().slice(0, 160) : ""
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}
