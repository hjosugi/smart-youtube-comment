// Cloudflare Worker — minimal stateless CORS relay for YouTube live chat.
//
// The ONLY job of the server: relay InnerTube (which the browser cannot call
// directly due to CORS) and attach CORS headers. No scoring, no dedupe, no
// rendering, no storage — all of that stays on the device. See ARCHITECTURE.md.
//
// Routes:
//   GET /api/livechat?video=<id>            -> resolve + first poll
//   GET /api/livechat?cont=<continuation>   -> subsequent poll
//
// Response: { messages, continuation, timeoutMs, ended }
//
// Abuse/IP-ban mitigation: responses are cached in the edge cache keyed by the
// request URL for the poll window (s-maxage = timeoutMs). N viewers of the same
// stream share one continuation token per window, so their polls collapse onto a
// single upstream InnerTube call instead of multiplying from the Worker's IP.

import { resolveContinuation, pollLiveChat } from "./innertube.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const VIDEO_ID_RE = /^[\w-]{11}$/;
const MAX_CONT_LEN = 8192;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/api/livechat") {
      return json({ error: "not found" }, 404);
    }

    const cont = url.searchParams.get("cont");
    const video = url.searchParams.get("video");

    // Validate before any upstream call (cheap, cuts abuse/typo round-trips).
    if (cont != null && cont.length > MAX_CONT_LEN) {
      return json({ error: "cont too long" }, 400);
    }
    if (!cont) {
      if (!video) return json({ error: "missing video or cont" }, 400);
      if (!VIDEO_ID_RE.test(video)) return json({ error: "invalid video id" }, 400);
    }

    // Collapse concurrent identical resolves/polls onto one upstream call.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      let continuation = cont;
      if (!continuation) {
        continuation = await resolveContinuation(video);
        if (!continuation) {
          return json({ error: "no live chat (not live or chat disabled)" }, 404);
        }
      }

      const result = await pollLiveChat(continuation);

      const ttl = Math.max(1, Math.floor((result.timeoutMs ?? 1000) / 1000));
      const resp = json(result, 200, { "Cache-Control": `public, s-maxage=${ttl}` });
      // Don't cache the terminal (ended) response — the stream may restart.
      if (!result.ended) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    } catch (e) {
      // Log detail (observability) but never echo upstream internals to clients.
      console.error("livechat relay error:", e?.status ?? "", e?.message ?? e);
      const upstream = Number(e?.status) || 502;
      const status = upstream === 429 ? 429 : 502;
      return json(
        { error: status === 429 ? "rate limited upstream" : "upstream error" },
        status
      );
    }
  },
};
