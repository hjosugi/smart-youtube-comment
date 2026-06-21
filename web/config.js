// Pure configuration + URL-param parsing for the PWA. No side effects.

export const RELAY_DEFAULT = "https://syc-livechat-relay.acofun.workers.dev"

// Danmaku config is now settings-driven (SYCSettings.toEngineConfig), with mobile
// tuning expressed through the schema's renderScalePct default + the renderer's
// adaptive cap — so there is no separate mobile override layer here.

// Accept a raw YouTube URL or a bare id; return the 11-char id or "".
export const parseVideoId = (raw = "") => {
  const s = String(raw).trim()
  const m =
    s.match(/[?&]v=([\w-]{11})/) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/\/(?:live|embed|shorts)\/([\w-]{11})/)
  if (m) return m[1]
  return /^[\w-]{11}$/.test(s) ? s : ""
}

// Start offset from a YouTube URL's t=/start= (supports "90", "9938s", "1h2m3s").
export const parseStartSeconds = (raw = "") => {
  const m = String(raw).match(/[?&#](?:t|start)=([\dhms]+)/i)
  if (!m) return 0
  const v = m[1]
  if (/^\d+$/.test(v)) return Number(v)
  const n = re => Number(v.match(re)?.[1] || 0)
  return n(/(\d+)h/) * 3600 + n(/(\d+)m/) * 60 + n(/(\d+)s/)
}

// A raw launch input (URL or bare id) -> { video, start }.
export const parseInput = (raw = "") => ({
  video: parseVideoId(raw),
  start: parseStartSeconds(raw),
})

export const readParams = (search = "") => {
  const p = new URLSearchParams(search)
  return {
    video: parseVideoId(p.get("v") || ""),
    start: parseStartSeconds(search) || parseStartSeconds(p.get("v") || ""),
    relay: p.get("relay") || RELAY_DEFAULT,
    mock: p.get("mock") === "1",
    perf: p.get("perf") === "1",
  }
}
