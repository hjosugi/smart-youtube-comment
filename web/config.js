// Pure configuration + URL-param parsing for the PWA. No side effects.

export const RELAY_DEFAULT = "https://syc-livechat-relay.acofun.workers.dev";

// Danmaku config is now settings-driven (SYCSettings.toEngineConfig), with mobile
// tuning expressed through the schema's renderScalePct default + the renderer's
// adaptive cap — so there is no separate mobile override layer here.

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
    perf: p.get("perf") === "1",
  };
};
