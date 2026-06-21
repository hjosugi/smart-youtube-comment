// YouTube IFrame Player — effect boundary. Loads the API once and resolves a
// player instance. Kept tiny; Wake Lock / Media Session live in their own module.

let apiPromise: Promise<any> | null = null

const loadApi = (): Promise<any> => {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT)
  apiPromise ??= new Promise<any>(resolve => {
    const g = globalThis as any
    const prev = g.onYouTubeIframeAPIReady
    g.onYouTubeIframeAPIReady = () => {
      prev?.()
      resolve(globalThis.YT)
    }
    const s = document.createElement("script")
    s.src = "https://www.youtube.com/iframe_api"
    document.head.appendChild(s)
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
        onStateChange: (e: any) => onState?.(STATE[e.data] ?? "playing"),
      },
    })
  })
}
