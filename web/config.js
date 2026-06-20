// Pure configuration + URL-param parsing for the PWA. No side effects.

export const RELAY_DEFAULT = "https://syc-livechat-relay.acofun.workers.dev";

// Mobile-tuned danmaku overrides (the web build diverges from extension defaults
// for phone GPUs — see ARCHITECTURE.md §5.1). Applied as config, not by editing
// the copied danmaku.js, so the core stays a clean copy.
export const mobileDanmaku = () => ({
  maxActive: 600,
  fontPx: 22,
  spawnPerFrame: 6,
  dpr: Math.min(globalThis.devicePixelRatio || 1, 2),
});

// Accept a raw YouTube URL or a bare id; return the 11-char id or "".
export const parseVideoId = (raw = "") => {
  const s = String(raw).trim();
  const m =
    s.match(/[?&]v=([\w-]{11})/) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/\/(?:live|embed|shorts)\/([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(s) ? s : "";
};

export const readParams = (search = "") => {
  const p = new URLSearchParams(search);
  return {
    video: parseVideoId(p.get("v") || ""),
    relay: p.get("relay") || RELAY_DEFAULT,
    mock: p.get("mock") === "1",
  };
};
