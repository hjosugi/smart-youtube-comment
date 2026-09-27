(() => {
  "use strict";

  const MAX_TEXT_LENGTH = 500;
  const MAX_AUTHOR_LENGTH = 80;
  const MAX_AMOUNT_LENGTH = 40;
  const VALID_KINDS = new Set(["text", "paid", "membership"]);
  const VALID_AUTHOR_TYPES = new Set(["normal", "member", "moderator", "owner"]);
  const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z0-9+/=\s]+$/i;
  const MAX_PARTS = 60;
  const MAX_PART_TEXT = 200;

  function sanitizeText(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function sanitizeNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function sanitizeCssColor(value) {
    if (typeof value !== "string") return null;
    const color = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    const rgb = color.match(/^rgba?\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*(0|1|0?\.\d+))?\)$/);
    if (!rgb) return null;
    const parts = rgb.slice(1, 4).map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return null;
    return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  }

  function sanitizeRenderPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    const text = sanitizeText(payload.text, MAX_TEXT_LENGTH);
    if (!text) return null;

    const kind = VALID_KINDS.has(payload.kind) ? payload.kind : "text";
    const authorType = VALID_AUTHOR_TYPES.has(payload.authorType) ? payload.authorType : "normal";

    return {
      text,
      parts: sanitizeMessageParts(payload.parts),
      author: sanitizeText(payload.author, MAX_AUTHOR_LENGTH),
      kind,
      authorType,
      amount: sanitizeText(payload.amount, MAX_AMOUNT_LENGTH) || null,
      paidColor: sanitizeCssColor(payload.paidColor),
      tier: sanitizeNumber(payload.tier, 1, 0, 2),
      durationMs: sanitizeNumber(payload.durationMs, 8500, 1000, 30000),
      score: sanitizeNumber(payload.score, 0, 0, 1),
      emphasis: sanitizeNumber(payload.emphasis, 0, 0, 1)
    };
  }

  // Untrusted emoji image URL. Only HTTPS assets from YouTube emoji hosts (or a
  // raster data URL) are allowed; anything else is dropped.
  function sanitizeEmojiUrl(value) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if (!text) return "";
    if (SAFE_DATA_IMAGE_RE.test(text)) return text;
    let url;
    try {
      url = new URL(text);
    } catch {
      return "";
    }
    if (url.protocol !== "https:") return "";
    if (url.username || url.password || url.port) return "";
    const host = url.hostname.toLowerCase();
    if (host !== "yt3.ggpht.com" && !host.endsWith(".googleusercontent.com")) return "";
    url.hash = "";
    return url.href;
  }

  // Render payload parts: { t } text or { u, a } emoji image. Unsafe image parts
  // fall back to their alt text; unknown shapes are dropped.
  function sanitizeMessageParts(parts) {
    if (!Array.isArray(parts)) return [];
    const safe = [];
    for (const part of parts) {
      if (safe.length >= MAX_PARTS) break;
      if (!part || typeof part !== "object") continue;
      if (part.t != null) {
        const t = String(part.t).slice(0, MAX_PART_TEXT);
        if (t) safe.push({ t });
        continue;
      }
      const url = sanitizeEmojiUrl(part.u);
      if (url) safe.push({ u: url, a: typeof part.a === "string" ? part.a.slice(0, MAX_PART_TEXT) : "" });
      else if (part.a) safe.push({ t: String(part.a).slice(0, MAX_PART_TEXT) });
    }
    return safe;
  }

  globalThis.SYCSanitize = {
    MAX_TEXT_LENGTH,
    MAX_AUTHOR_LENGTH,
    MAX_AMOUNT_LENGTH,
    sanitizeText,
    sanitizeNumber,
    sanitizeCssColor,
    sanitizeEmojiUrl,
    sanitizeMessageParts,
    sanitizeRenderPayload
  };
})();
