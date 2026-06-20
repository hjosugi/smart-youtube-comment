// Cloudflare Worker — minimal stateless CORS relay for YouTube live chat.
//
// The ONLY job of the server: relay InnerTube (which the browser cannot call
// directly due to CORS) and attach CORS headers. No scoring, no dedupe, no
// rendering, no storage — all of that stays on the device. See ARCHITECTURE.md.
//
// Routes:
//   GET /api/livechat?video=<id>            -> resolve + first poll
//   GET /api/livechat?cont=<continuation>   -> subsequent poll
// Response: { messages, continuation, timeoutMs, ended }
//
// Abuse/IP-ban mitigation: responses are cached in the edge cache keyed by the
// request URL for the poll window (s-maxage = timeoutMs). Polls for the same
// continuation that arrive AFTER the first response is stored are served from
// cache (one upstream call serves the window). NOTE: there is NO in-flight
// coalescing — N *simultaneous* cold-key requests all miss and all go upstream
// during the ~1s cache-population gap. True single-flight needs a Durable Object
// (paid plan); acceptable for the current scale. See ARCHITECTURE.md §7.1.

import { resolveContinuation, pollLiveChat } from "./innertube.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // Cache the preflight so a per-poll OPTIONS can't appear and halve the request
  // budget. (Device polls use only CORS-safelisted headers, so none should fire.)
  "Access-Control-Max-Age": "86400",
};

const VIDEO_ID_RE = /^[\w-]{11}$/;
const MAX_CONT_LEN = 8192;

// ---- pure helpers -----------------------------------------------------------

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

const readParams = (url) => ({
  cont: url.searchParams.get("cont"),
  video: url.searchParams.get("video"),
});

// Returns an error message string, or null when the params are acceptable.
const validate = ({ cont, video }) => {
  if (cont != null && cont.length > MAX_CONT_LEN) return "cont too long";
  if (!cont && !video) return "missing video or cont";
  if (!cont && !VIDEO_ID_RE.test(video)) return "invalid video id";
  return null;
};

// Map an upstream error to a client-facing response (never leak internals).
const errorResponse = (e) => {
  const status = Number(e?.status) === 429 ? 429 : 502;
  return json({ error: status === 429 ? "rate limited upstream" : "upstream error" }, status);
};

// ---- effectful handler ------------------------------------------------------

const handle = async (request, ctx) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(request.url);
  if (url.pathname !== "/api/livechat") return json({ error: "not found" }, 404);

  const params = readParams(url);
  const invalid = validate(params);
  if (invalid) return json({ error: invalid }, 400);

  // Collapse concurrent identical resolves/polls onto one upstream call.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    // Served from edge cache — no upstream call. Marker aids ops/load testing.
    const r = new Response(hit.body, hit);
    r.headers.set("X-SYC-Cache", "HIT");
    return r;
  }

  try {
    const continuation = params.cont ?? (await resolveContinuation(params.video));
    if (!continuation) return json({ error: "no live chat (not live or chat disabled)" }, 404);

    const result = await pollLiveChat(continuation);
    const ttl = Math.max(1, Math.floor((result.timeoutMs ?? 1000) / 1000));
    const resp = json(result, 200, {
      "Cache-Control": `public, s-maxage=${ttl}`,
      "X-SYC-Cache": "MISS",
    });
    // Don't cache the terminal (ended) response — the stream may restart.
    if (!result.ended) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    console.error("livechat relay error:", e?.status ?? "", e?.message ?? e);
    return errorResponse(e);
  }
};

export default {
  fetch: (request, env, ctx) => handle(request, ctx),
};
