// InnerTube live-chat relay logic (pure, runtime-agnostic).
//
// Runs unchanged in a Cloudflare Worker and in Node (via worker/test/probe.mjs).
// Responsibilities: resolve the initial live-chat continuation for a video,
// poll get_live_chat, and normalize actions into the ChatMessage shape from
// docs/CONTRACT.md. NO scoring/dedupe/render — that is the device's job.

const INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1";

// Public WEB client identity. No API key required when a valid context is POSTed.
const CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20240814.00.00",
};

const FETCH_TIMEOUT_MS = 3500; // per-attempt bound; a hung request aborts and is retried
const MAX_ATTEMPTS = 2; // total tries (1 + 1 retry): absorb a SINGLE blip, keep worst-case
                        // latency bounded (~7s < poll cadence). Sustained blips are handled
                        // by the device's adaptive backoff, not by hammering here.
const RETRY_BACKOFF_MS = 200; // base backoff before the retry (plus jitter)
const MIN_TIMEOUT_MS = 250; // floor for the poll interval YouTube hands back
const DEFAULT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000; // cap an absurd value so the device can't be parked forever

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// YouTube's InnerTube is reachable from Cloudflare egress IPs but occasionally
// tarpits a request (it hangs to our timeout) or returns 429/5xx. These are
// transient and clear on retry, so a 4xx is NOT retried but a timeout/429/5xx is.
function isRetriable(status) {
  return status === 504 || status === 429 || (status >= 500 && status < 600);
}

// POST to InnerTube with a per-attempt timeout + bounded retry. Throws Error with
// a `.status` hint (504 = timeout, upstream HTTP status, or 502 = non-JSON body).
// The thrown message carries a body snippet for observability (the Worker logs
// it but does not echo it to clients).
async function innertubePost(endpoint, body) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await innertubePostOnce(endpoint, body);
    } catch (e) {
      lastErr = e;
      if (!isRetriable(e?.status) || attempt === MAX_ATTEMPTS) throw e;
      await sleep(RETRY_BACKOFF_MS * attempt + Math.floor(Math.random() * RETRY_BACKOFF_MS));
    }
  }
  throw lastErr;
}

async function innertubePostOnce(endpoint, body) {
  const ac = new AbortController();
  // The timeout must cover the WHOLE round-trip (headers AND body) — YouTube can
  // tarpit the body, so clearing it right after fetch() would leave res.text()
  // unbounded. Keep the signal armed until the body is fully read.
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${INNERTUBE_BASE}/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.youtube.com",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    // Read the body once: YouTube may answer non-2xx (429/5xx) or 200-with-HTML
    // (consent/bot gate). Either must surface a clear, status-tagged error.
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`InnerTube ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error(
        `InnerTube ${endpoint} non-JSON (status ${res.status}): ${text.slice(0, 120)}`
      );
      err.status = 502;
      throw err;
    }
  } catch (e) {
    if (e?.status) throw e; // already-tagged HTTP/non-JSON error — pass through
    const err = new Error(
      `InnerTube ${endpoint} fetch failed: ${e?.name === "AbortError" ? "timeout" : e?.message}`
    );
    err.status = 504; // network error or abort (timeout)
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function context() {
  return { context: { client: CLIENT } };
}

// --- continuation resolution -------------------------------------------------

// Resolve the initial live-chat continuation token from a watch page.
// Returns the token string, or null if the video has no live chat.
export async function resolveContinuation(videoId) {
  const data = await innertubePost("next", { ...context(), videoId });
  const lc =
    data?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
  if (!lc) return null;

  // Use the default reload continuation from liveChatRenderer.continuations.
  // (The header sub-menu "Top chat"/"Live chat" tokens are a separate, shorter
  // selector continuation and are NOT valid get_live_chat polling tokens.)
  return extractContinuation(lc.continuations).token;
}

function extractContinuation(continuations) {
  const c = continuations?.[0];
  if (!c) return { token: null, timeoutMs: DEFAULT_TIMEOUT_MS };
  const d =
    c.invalidationContinuationData ??
    c.timedContinuationData ??
    c.reloadContinuationData ??
    c.liveChatReplayContinuationData;
  let ms = Number(d?.timeoutMs);
  if (!Number.isFinite(ms) || ms < MIN_TIMEOUT_MS) ms = DEFAULT_TIMEOUT_MS;
  if (ms > MAX_TIMEOUT_MS) ms = MAX_TIMEOUT_MS;
  return { token: d?.continuation ?? null, timeoutMs: ms };
}

// --- polling -----------------------------------------------------------------

// Poll one batch. Returns { messages, continuation, timeoutMs, ended }.
// When the stream ends YouTube stops issuing continuations; we surface that as
// `ended: true` + `continuation: null` so the device stops polling instead of
// busy-looping on a dead token.
export async function pollLiveChat(continuation) {
  const data = await innertubePost("live_chat/get_live_chat", {
    ...context(),
    continuation,
  });
  const lc = data?.continuationContents?.liveChatContinuation;
  const actions = lc?.actions ?? [];
  const messages = actions.map(parseAction).filter(Boolean);
  const next = extractContinuation(lc?.continuations);
  const ended = !next.token; // no fresh continuation => chat is over
  return {
    messages,
    continuation: ended ? null : next.token,
    timeoutMs: next.timeoutMs,
    ended,
  };
}

// --- normalization -----------------------------------------------------------

function parseAction(action) {
  // A message arrives directly, or as a replacement for an earlier placeholder
  // (YouTube shows liveChatPlaceholderItemRenderer first, then swaps in content).
  const item =
    action?.addChatItemAction?.item ?? action?.replaceChatItemAction?.replacementItem;
  return item ? parseItem(item) : null;
}

function parseItem(item) {
  if (item.liveChatTextMessageRenderer) {
    return toMessage(item.liveChatTextMessageRenderer, "text", null);
  }
  if (item.liveChatPaidMessageRenderer) {
    const r = item.liveChatPaidMessageRenderer;
    return toMessage(r, "paid", r.purchaseAmountText?.simpleText ?? null);
  }
  if (item.liveChatPaidStickerRenderer) {
    // Super Sticker: a paid event with no text body.
    const r = item.liveChatPaidStickerRenderer;
    return toMessage(r, "paid", r.purchaseAmountText?.simpleText ?? null);
  }
  if (item.liveChatMembershipItemRenderer) {
    return toMessage(item.liveChatMembershipItemRenderer, "membership", null);
  }
  if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
    // "X gifted N memberships" — different shape (text under header).
    return toSponsorshipMessage(
      item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer
    );
  }
  // liveChatPlaceholderItemRenderer, viewer-engagement, gift *redemption*, and
  // unknown renderer types are intentionally ignored.
  return null;
}

function toMessage(r, kind, amount) {
  let text = runsToText(r.message ?? r.headerSubtext);
  // Paid messages/stickers often carry money but no comment; without text the
  // device renderer drops them (danmaku requires payload.text). Fall back to the
  // amount so the highest-priority content is always renderable.
  if (!text && kind === "paid") text = amount ?? "";
  return {
    id: r.id ?? "",
    ts: r.timestampUsec ? Math.floor(Number(r.timestampUsec) / 1000) : 0,
    kind,
    author: r.authorName?.simpleText ?? "",
    authorType: authorTypeFromBadges(r.authorBadges),
    authorColor: null,
    text,
    amount,
  };
}

function toSponsorshipMessage(r) {
  const h = r.header?.liveChatSponsorshipsHeaderRenderer;
  return {
    id: r.id ?? "",
    ts: r.timestampUsec ? Math.floor(Number(r.timestampUsec) / 1000) : 0,
    kind: "membership",
    author: h?.authorName?.simpleText ?? "",
    authorType: authorTypeFromBadges(h?.authorBadges),
    authorColor: null,
    text: runsToText(h?.primaryText),
    amount: null,
  };
}

function runsToText(message) {
  if (!message) return "";
  if (message.simpleText) return message.simpleText;
  return (message.runs ?? [])
    .map((run) => {
      if (run.text) return run.text;
      if (run.emoji) {
        return run.emoji.shortcuts?.[0] ?? run.emoji.emojiId ?? "";
      }
      return "";
    })
    .join("");
}

function authorTypeFromBadges(badges) {
  let type = "normal";
  for (const b of badges ?? []) {
    const badge = b.liveChatAuthorBadgeRenderer;
    const icon = badge?.icon?.iconType;
    if (icon === "OWNER") return "owner";
    if (icon === "MODERATOR") {
      type = "moderator";
    } else if (badge?.customThumbnail && type === "normal") {
      type = "member"; // sponsor/member badge has a custom thumbnail, no iconType
    }
  }
  return type;
}
