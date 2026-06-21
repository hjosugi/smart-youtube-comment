// Cloudflare Worker — minimal stateless CORS relay for YouTube live chat.
//
// The ONLY job of the server: relay InnerTube (which the browser cannot call
// directly due to CORS) and attach CORS headers. No scoring, no dedupe, no
// rendering, no storage — that all stays on the device. See ARCHITECTURE.md.
//
// Routes:
//   GET /api/livechat?video=<id>             -> resolve + first poll
//   GET /api/livechat?cont=<token>           -> next live poll
//   GET /api/livechat?cont=<token>&offset=ms -> next replay (VOD) poll at offset
// Response: { messages, continuation, timeoutMs, ended, isReplay }
//
// Edge cache (s-maxage = timeoutMs) collapses post-population polls of the same
// continuation onto one upstream call (IP-ban mitigation, NOT a quota win — see
// ARCHITECTURE.md §9.1). There is no in-flight coalescing.

import { resolveLiveChat, pollLiveChat } from "./innertube.ts"
import type { PollEnvelope } from "../../web/types.ts"

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

interface Params {
  cont: string | null
  video: string | null
  offset: number | null
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400", // no per-poll preflight (device uses safelisted headers)
}

const VIDEO_ID_RE = /^[\w-]{11}$/
const MAX_CONT_LEN = 8192

// ---- pure helpers -----------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  })

const withHeader = (resp: Response, key: string, value: string): Response => {
  const r = new Response(resp.body, resp)
  r.headers.set(key, value)
  return r
}

const readParams = (url: URL): Params => ({
  cont: url.searchParams.get("cont"),
  video: url.searchParams.get("video"),
  offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : null,
})

// Returns an error message, or null when the params are acceptable.
const validate = ({ cont, video, offset }: Params): string | null => {
  if (cont != null && cont.length > MAX_CONT_LEN) return "cont too long"
  if (offset != null && !Number.isFinite(offset)) return "invalid offset"
  if (!cont && !video) return "missing video or cont"
  if (!cont && !VIDEO_ID_RE.test(video ?? "")) return "invalid video id"
  return null
}

// Map an upstream error to a client response (never leak internals).
const errorResponse = (e: any): Response => {
  const status = Number(e?.status) === 429 ? 429 : 502
  return json({ error: status === 429 ? "rate limited upstream" : "upstream error" }, status)
}

// ---- effectful pieces -------------------------------------------------------

// Resolve (?video=) or poll (?cont=) -> envelope, or null if there is no chat.
const fetchEnvelope = async ({ cont, video, offset }: Params): Promise<PollEnvelope | null> => {
  if (cont) {
    return pollLiveChat(cont, offset != null ? { replay: true, offsetMs: offset } : {})
  }
  const resolved = await resolveLiveChat(video ?? "")
  if (!resolved?.continuation) return null
  const opts = resolved.isReplay ? { replay: true, offsetMs: offset ?? 0 } : {}
  return pollLiveChat(resolved.continuation, opts)
}

// Return the envelope as JSON and (unless terminal) store it for the poll window.
const cacheable = (
  cache: Cache,
  key: Request,
  ctx: ExecutionContext,
  result: PollEnvelope,
): Response => {
  const ttl = Math.max(1, Math.floor((result.timeoutMs ?? 1000) / 1000))
  const resp = json(result, 200, {
    "Cache-Control": `public, s-maxage=${ttl}`,
    "X-SYC-Cache": "MISS",
  })
  if (!result.ended) ctx.waitUntil(cache.put(key, resp.clone()))
  return resp
}

const handle = async (request: Request, ctx: ExecutionContext): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405)

  const url = new URL(request.url)
  if (url.pathname !== "/api/livechat") return json({ error: "not found" }, 404)

  const params = readParams(url)
  const invalid = validate(params)
  if (invalid) return json({ error: invalid }, 400)

  const cache: Cache = (caches as any).default
  const cacheKey = new Request(url.toString(), { method: "GET" })
  const cached = await cache.match(cacheKey)
  if (cached) return withHeader(cached, "X-SYC-Cache", "HIT")

  try {
    const result = await fetchEnvelope(params)
    if (!result) return json({ error: "no live chat (not live or chat disabled)" }, 404)
    return cacheable(cache, cacheKey, ctx, result)
  } catch (e: any) {
    console.error("livechat relay error:", e?.status ?? "", e?.message ?? e)
    return errorResponse(e)
  }
}

export default {
  fetch: (request: Request, _env: unknown, ctx: ExecutionContext) => handle(request, ctx),
}
