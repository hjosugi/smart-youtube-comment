// Cloudflare Worker — minimal stateless CORS relay for YouTube live chat.
//
// The ONLY job of the server: relay InnerTube (which the browser cannot call
// directly due to CORS) and attach CORS headers. No scoring, no dedupe, no
// rendering, no storage — that all stays on the device. See ARCHITECTURE.md.
//
// Routes:
//   GET /health                             -> lightweight worker health
//   GET /api/livechat?video=<id>             -> resolve + first poll
//   GET /api/livechat?cont=<token>           -> next live poll
//   GET /api/livechat?cont=<token>&offset=ms -> next replay (VOD) poll at offset
// Response: { messages, continuation, timeoutMs, ended, isReplay }
//
// Edge cache (s-maxage = floor(timeoutMs / 1000)) collapses post-population
// polls of the same normalized key onto one upstream call (IP-ban mitigation,
// NOT a quota win — see ARCHITECTURE.md §9.1). A small in-isolate in-flight map
// also collapses cold-key bursts before cache population.

import { INNERTUBE_CLIENT_VERSION, resolveLiveChat, pollLiveChat } from "./innertube.ts"
import type { PollEnvelope } from "../../web/types.ts"

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

interface Env {
  SYC_VERSION?: string
  COMMIT_SHA?: string
  SOURCE_VERSION?: string
  HEALTHCHECK_VIDEO_ID?: string
}

interface Params {
  cont: string | null
  video: string | null
  offset: number | null
}

interface HandlerDeps {
  cache?: Cache
  fetchEnvelope?: (params: Params) => Promise<PollEnvelope | null>
  healthProbe?: (videoId: string) => Promise<unknown>
  inflight?: Map<string, Promise<Response>>
  logError?: (...args: unknown[]) => void
  now?: () => Date
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400", // no per-poll preflight (device uses safelisted headers)
}

const VIDEO_ID_RE = /^[\w-]{11}$/
const CONTINUATION_RE = /^[A-Za-z0-9_-][A-Za-z0-9._=-]*$/
const MAX_CONT_LEN = 8192
const REPLAY_CACHE_BUCKET_MS = 3000
const NEGATIVE_CACHE_TTL_SECONDS = 1
const inflightResponses = new Map<string, Promise<Response>>()

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
  if (cont != null && !CONTINUATION_RE.test(cont)) return "invalid cont"
  if (offset != null && !Number.isFinite(offset)) return "invalid offset"
  if (!cont && !video) return "missing video or cont"
  if (!cont && !VIDEO_ID_RE.test(video ?? "")) return "invalid video id"
  return null
}

const normalizeOffset = (offset: number): number =>
  Math.floor(Math.max(0, offset) / REPLAY_CACHE_BUCKET_MS) * REPLAY_CACHE_BUCKET_MS

const cacheKeyFor = (url: URL, params: Params): Request => {
  const normalized = new URL(url.origin + url.pathname)
  if (params.cont) normalized.searchParams.set("cont", params.cont)
  else if (params.video) normalized.searchParams.set("video", params.video)
  if (params.offset != null)
    normalized.searchParams.set("offset", String(normalizeOffset(params.offset)))
  return new Request(normalized.toString(), { method: "GET" })
}

// Map an upstream error to a client response (never leak internals).
const errorResponse = (e: any, params: Params): Response => {
  const upstreamStatus = Number(e?.status)
  const headers = {
    "Cache-Control": `public, s-maxage=${NEGATIVE_CACHE_TTL_SECONDS}`,
    "X-SYC-Cache": "NEGATIVE",
  }
  if (upstreamStatus === 429) return json({ error: "rate limited upstream" }, 429, headers)
  if (params.cont && upstreamStatus >= 400 && upstreamStatus < 500) {
    return json({ error: "stale continuation", reResolve: true }, 410, headers)
  }
  return json({ error: "upstream error" }, 502, headers)
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

const versionFromEnv = (env: Env): string =>
  env.SYC_VERSION ?? env.COMMIT_SHA ?? env.SOURCE_VERSION ?? "dev"

const healthBody = async (url: URL, env: Env, deps: HandlerDeps) => {
  const body: Record<string, unknown> = {
    status: "ok",
    service: "syc-livechat-relay",
    version: versionFromEnv(env),
    innerTubeClientVersion: INNERTUBE_CLIENT_VERSION,
    timestamp: (deps.now ?? (() => new Date()))().toISOString(),
  }

  if (url.searchParams.get("deep") !== "1") return body

  const canaryVideoId = url.searchParams.get("video") ?? env.HEALTHCHECK_VIDEO_ID
  if (!canaryVideoId) {
    body.upstream = { checked: false, reason: "canary video not configured" }
    return body
  }
  if (!VIDEO_ID_RE.test(canaryVideoId)) {
    body.upstream = { checked: false, reason: "invalid canary video id" }
    return body
  }

  try {
    const probe = deps.healthProbe ?? ((videoId: string) => resolveLiveChat(videoId))
    body.upstream = { checked: true, ok: true, result: await probe(canaryVideoId) }
  } catch (e: any) {
    body.status = "degraded"
    body.upstream = { checked: true, ok: false, status: e?.status ?? null }
  }
  return body
}

// Return the envelope as JSON and (unless terminal) store it for the poll window.
const cacheable = (
  cache: Cache,
  key: Request,
  ctx: ExecutionContext,
  result: PollEnvelope,
): Response => {
  const ttl = Math.floor((result.timeoutMs ?? 1000) / 1000)
  if (ttl < 1 || result.ended) {
    return json(result, 200, {
      "Cache-Control": "no-store",
      "X-SYC-Cache": "BYPASS",
    })
  }
  const resp = json(result, 200, {
    "Cache-Control": `public, s-maxage=${ttl}`,
    "X-SYC-Cache": "MISS",
  })
  ctx.waitUntil(cache.put(key, resp.clone()))
  return resp
}

const cacheNegative = (
  cache: Cache,
  key: Request,
  ctx: ExecutionContext,
  response: Response,
): Response => {
  ctx.waitUntil(cache.put(key, response.clone()))
  return response
}

export const handle = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: HandlerDeps = {},
): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405)

  const url = new URL(request.url)
  if (url.pathname === "/health") {
    return json(await healthBody(url, env, deps))
  }
  if (url.pathname !== "/api/livechat") return json({ error: "not found" }, 404)

  const params = readParams(url)
  const invalid = validate(params)
  if (invalid) return json({ error: invalid }, 400)

  const cache: Cache = deps.cache ?? (caches as any).default
  const cacheKey = cacheKeyFor(url, params)
  const cached = await cache.match(cacheKey)
  if (cached) return withHeader(cached, "X-SYC-Cache", "HIT")

  const inflight = deps.inflight ?? inflightResponses
  const inflightKey = cacheKey.url
  const existing = inflight.get(inflightKey)
  if (existing) return withHeader((await existing).clone(), "X-SYC-Inflight", "HIT")

  const pending = (async () => {
    try {
      const result = await (deps.fetchEnvelope ?? fetchEnvelope)(params)
      if (!result) return json({ error: "no live chat (not live or chat disabled)" }, 404)
      return cacheable(cache, cacheKey, ctx, result)
    } catch (e: any) {
      ;(deps.logError ?? console.error)("livechat relay error:", e?.status ?? "", e?.message ?? e)
      return cacheNegative(cache, cacheKey, ctx, errorResponse(e, params))
    }
  })()
  inflight.set(inflightKey, pending)
  try {
    return (await pending).clone()
  } finally {
    inflight.delete(inflightKey)
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => handle(request, env, ctx),
}

export const _test = {
  validate,
  readParams,
  cacheKeyFor,
  normalizeOffset,
  healthBody,
  cacheable,
  errorResponse,
}
