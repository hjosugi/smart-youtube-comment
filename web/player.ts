// YouTube IFrame Player — effect boundary. Loads the API once and resolves a
// player instance. Kept tiny; Wake Lock / Media Session live in their own module.

let apiPromise: Promise<any> | null = null

export const API_LOAD_TIMEOUT_MS = 10_000

export const loadApi = ({ timeoutMs = API_LOAD_TIMEOUT_MS } = {}): Promise<any> => {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT)
  apiPromise ??= new Promise<any>((resolve, reject) => {
    const g = globalThis as any
    const prev = g.onYouTubeIframeAPIReady
    const script = document.createElement("script")
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      script.onerror = null
      if (g.onYouTubeIframeAPIReady === ready) {
        if (prev) g.onYouTubeIframeAPIReady = prev
        else delete g.onYouTubeIframeAPIReady
      }
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      apiPromise = null
      reject(error)
    }
    const ready = () => {
      if (settled) return
      try {
        prev?.()
      } catch {
        // Keep our loader isolated from unrelated global callback failures.
      }
      if (!globalThis.YT?.Player) {
        fail(new Error("YouTube IFrame API ready callback did not expose Player"))
        return
      }
      settled = true
      cleanup()
      resolve(globalThis.YT)
    }
    const timer = setTimeout(
      () => fail(new Error("YouTube IFrame API load timed out")),
      Math.max(1, timeoutMs),
    )

    g.onYouTubeIframeAPIReady = ready
    script.async = true
    script.src = "https://www.youtube.com/iframe_api"
    script.onerror = () => fail(new Error("YouTube IFrame API failed to load"))
    document.head.appendChild(script)
  })
  return apiPromise
}

// Replace the element #elementId with a player for videoId; resolve when ready.
// onState(stateName) fires on playback changes ("playing" | "paused" | "ended"),
// letting the caller suspend chat polling when not actively watching.
const STATE: Record<number, string> = {
  1: "playing",
  2: "paused",
  0: "ended",
  5: "paused",
  3: "playing",
}

export const mountPlayer = async (
  elementId: string,
  videoId: string,
  onState?: (state: string) => void,
  startSeconds = 0,
): Promise<any> => {
  const YT = await loadApi()
  return new Promise<any>(resolve => {
    const player = new YT.Player(elementId, {
      videoId,
      playerVars: {
        playsinline: 1,
        modestbranding: 1,
        rel: 0,
        controls: 0,
        fs: 0,
        start: Math.max(0, Math.floor(startSeconds)) || undefined,
      },
      events: {
        onReady: () => resolve(player),
        onStateChange: (e: any) => onState?.(STATE[e.data] ?? "paused"),
      },
    })
  })
}
