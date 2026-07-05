// Toolbar icon opens the settings page (no popup defined).
chrome.action?.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

const MAX_TEXT_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 80;
const VALID_KINDS = new Set(["text", "paid", "membership"]);
const VALID_AUTHOR_TYPES = new Set(["normal", "member", "moderator", "owner"]);

function sanitizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeRenderPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const text = sanitizeText(payload.text, MAX_TEXT_LENGTH);
  if (!text) return null;

  const kind = VALID_KINDS.has(payload.kind) ? payload.kind : "text";
  const authorType = VALID_AUTHOR_TYPES.has(payload.authorType) ? payload.authorType : "normal";
  const reasons = Array.isArray(payload.reasons)
    ? payload.reasons.filter((reason) => typeof reason === "string").slice(0, 10)
    : [];

  return {
    text,
    author: sanitizeText(payload.author, MAX_AUTHOR_LENGTH),
    kind,
    authorType,
    tier: sanitizeNumber(payload.tier, 1, 0, 2),
    durationMs: sanitizeNumber(payload.durationMs, 8500, 1000, 30000),
    score: sanitizeNumber(payload.score, 0, 0, 1),
    emphasis: sanitizeNumber(payload.emphasis, 0, 0, 1),
    reasons,
    createdAt: sanitizeNumber(payload.createdAt, Date.now(), 0, Date.now() + 60000)
  };
}

function isAllowedSender(sender) {
  if (!sender.tab?.id) return false;
  try {
    return new URL(sender.url ?? "").hostname === "www.youtube.com";
  } catch {
    return false;
  }
}

if (globalThis.__SYC_TEST__) {
  globalThis.__SYCBackgroundTest = {
    sanitizeText,
    sanitizeNumber,
    sanitizeRenderPayload,
    isAllowedSender
  };
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "smart-comment:chat-message") return false;
  if (!isAllowedSender(sender)) return false;

  const payload = sanitizeRenderPayload(message.payload);
  if (!payload) return false;

  chrome.tabs.sendMessage(
    sender.tab.id,
    {
      type: "smart-comment:render-message",
      payload
    },
    { frameId: 0 },
    () => {
      void chrome.runtime.lastError;
    }
  );

  return false;
});
