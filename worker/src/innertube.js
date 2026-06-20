// InnerTube live-chat relay logic (pure, runtime-agnostic).
//
// Runs unchanged in a Cloudflare Worker and in Node (via worker/test/probe.mjs).
// Structured as a thin IO layer (innertubePost) over a body of PURE transforms
// (normalization + continuation extraction). The IO functions resolve the
// initial continuation and poll get_live_chat; everything else is data->data.
// NO scoring/dedupe/render — that is the device's job. Shapes: docs/CONTRACT.md.

const INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1";

// Public WEB client identity. No API key required when a valid context is POSTed.
const CLIENT = { clientName: "WEB", clientVersion: "2.20240814.00.00" };

const FETCH_TIMEOUT_MS = 3500; // per-attempt bound; a hung request aborts and is retried
const MAX_ATTEMPTS = 2; // total tries (1 + 1 retry): absorb a SINGLE blip, keep worst-case
                        // latency bounded (~7s < poll cadence). Sustained blips are handled
                        // by the device's adaptive backoff, not by hammering here.
const RETRY_BACKOFF_MS = 200; // base backoff before the retry (plus jitter)
const MIN_TIMEOUT_MS = 250; // floor for the poll interval YouTube hands back
const DEFAULT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000; // cap an absurd value so the device can't be parked forever

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = () => ({ context: { client: CLIENT } });

// ---- IO layer ---------------------------------------------------------------

// YouTube's InnerTube is reachable from Cloudflare egress IPs but occasionally
// tarpits a request (it hangs to our timeout) or returns 429/5xx. These are
// transient and clear on retry; a 4xx is deterministic and is NOT retried.
const isRetriable = (status) => status === 504 || status === 429 || (status >= 500 && status < 600);

// POST with a per-attempt timeout + bounded, jittered retry (recursive).
const postWithRetry = async (endpoint, body, attempt = 1) => {
  try {
    return await postOnce(endpoint, body);
  } catch (e) {
    if (!isRetriable(e?.status) || attempt >= MAX_ATTEMPTS) throw e;
    await sleep(RETRY_BACKOFF_MS * attempt + Math.floor(Math.random() * RETRY_BACKOFF_MS));
    return postWithRetry(endpoint, body, attempt + 1);
  }
};

const innertubePost = (endpoint, body) => postWithRetry(endpoint, body);

// Single attempt. The timeout covers the WHOLE round-trip (headers AND body —
// YouTube can tarpit the body). Throws Error tagged with `.status`:
//   504 = network/timeout, upstream HTTP status, or 502 = non-JSON body.
async function postOnce(endpoint, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${INNERTUBE_BASE}/${endpoint}?prettyPrint=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://www.youtube.com" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw tagged(`InnerTube ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    try {
      return JSON.parse(text);
    } catch {
      throw tagged(`InnerTube ${endpoint} non-JSON (status ${res.status}): ${text.slice(0, 120)}`, 502);
    }
  } catch (e) {
    if (e?.status) throw e; // already-tagged HTTP/non-JSON error — pass through
    throw tagged(`InnerTube ${endpoint} fetch failed: ${e?.name === "AbortError" ? "timeout" : e?.message}`, 504);
  } finally {
    clearTimeout(timer);
  }
}

const tagged = (message, status) => Object.assign(new Error(message), { status });

// ---- IO entry points --------------------------------------------------------

// Resolve the initial live-chat continuation token, or null if no live chat.
export const resolveContinuation = async (videoId) => {
  const data = await innertubePost("next", { ...context(), videoId });
  const lc = data?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
  return lc ? extractContinuation(lc.continuations).token : null;
};

// Poll one batch. Returns { messages, continuation, timeoutMs, ended }.
// When the stream ends YouTube stops issuing continuations; we surface that as
// `ended: true` + `continuation: null` so the device stops polling.
export const pollLiveChat = async (continuation) => {
  const data = await innertubePost("live_chat/get_live_chat", { ...context(), continuation });
  const lc = data?.continuationContents?.liveChatContinuation;
  const messages = (lc?.actions ?? []).map(parseAction).filter(Boolean);
  const { token, timeoutMs } = extractContinuation(lc?.continuations);
  return { messages, continuation: token, timeoutMs, ended: !token };
};

// ---- pure: continuation extraction -----------------------------------------

const CONT_DATA_KEYS = [
  "invalidationContinuationData",
  "timedContinuationData",
  "reloadContinuationData",
  "liveChatReplayContinuationData",
];

const pickContData = (c = {}) => CONT_DATA_KEYS.map((k) => c[k]).find(Boolean) ?? {};

const clampTimeout = (ms) =>
  !Number.isFinite(ms) || ms < MIN_TIMEOUT_MS ? DEFAULT_TIMEOUT_MS : Math.min(ms, MAX_TIMEOUT_MS);

const extractContinuation = (continuations = []) => {
  const d = pickContData(continuations[0]);
  return { token: d.continuation ?? null, timeoutMs: clampTimeout(Number(d.timeoutMs)) };
};

// ---- pure: normalization ----------------------------------------------------

const msToTs = (usec) => (usec ? Math.floor(Number(usec) / 1000) : 0);

const runsToText = (node) => {
  if (!node) return "";
  if (node.simpleText) return node.simpleText;
  return (node.runs ?? [])
    .map((run) => run.text ?? run.emoji?.shortcuts?.[0] ?? run.emoji?.emojiId ?? "")
    .join("");
};

// owner > moderator > member > normal (member badge has a custom thumbnail, no iconType)
const authorTypeFromBadges = (badges = []) => {
  const renderers = badges.map((b) => b.liveChatAuthorBadgeRenderer);
  if (renderers.some((b) => b?.icon?.iconType === "OWNER")) return "owner";
  if (renderers.some((b) => b?.icon?.iconType === "MODERATOR")) return "moderator";
  if (renderers.some((b) => b?.customThumbnail)) return "member";
  return "normal";
};

const message = ({ id, ts, kind, author, authorType, text, amount }) => ({
  id: id ?? "",
  ts,
  kind,
  author: author ?? "",
  authorType,
  authorColor: null,
  text,
  amount: amount ?? null,
});

const amountOf = (r) => r.purchaseAmountText?.simpleText ?? null;

// A standard author/timestamp/message renderer -> ChatMessage. Paid items often
// carry money but no comment, so fall back to the amount (the renderer needs text).
const fromRenderer = (kind, amount) => (r) =>
  message({
    id: r.id,
    ts: msToTs(r.timestampUsec),
    kind,
    author: r.authorName?.simpleText,
    authorType: authorTypeFromBadges(r.authorBadges),
    text: runsToText(r.message ?? r.headerSubtext) || (kind === "paid" ? amount ?? "" : ""),
    amount,
  });

// "X gifted N memberships" — text lives under the header, not message/headerSubtext.
const fromSponsorship = (r) => {
  const h = r.header?.liveChatSponsorshipsHeaderRenderer;
  return message({
    id: r.id,
    ts: msToTs(r.timestampUsec),
    kind: "membership",
    author: h?.authorName?.simpleText,
    authorType: authorTypeFromBadges(h?.authorBadges),
    text: runsToText(h?.primaryText),
    amount: null,
  });
};

// Declarative renderer dispatch. Unknown/placeholder/redemption renderers map to
// nothing and are dropped by the .filter(Boolean) in pollLiveChat.
const RENDERERS = {
  liveChatTextMessageRenderer: fromRenderer("text", null),
  liveChatPaidMessageRenderer: (r) => fromRenderer("paid", amountOf(r))(r),
  liveChatPaidStickerRenderer: (r) => fromRenderer("paid", amountOf(r))(r),
  liveChatMembershipItemRenderer: fromRenderer("membership", null),
  liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: fromSponsorship,
};

const parseItem = (item = {}) => {
  const key = Object.keys(item).find((k) => k in RENDERERS);
  return key ? RENDERERS[key](item[key]) : null;
};

// A message arrives directly, or as a replacement for an earlier placeholder.
const parseAction = (action) => {
  const item = action?.addChatItemAction?.item ?? action?.replaceChatItemAction?.replacementItem;
  return item ? parseItem(item) : null;
};

// Exposed for unit tests of the pure transforms (no network required).
export const _pure = { parseAction, parseItem, extractContinuation, authorTypeFromBadges, runsToText };
