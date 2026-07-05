import test from "node:test"
import assert from "node:assert/strict"

import { handle } from "../src/index.ts"

const req = (path, init) => new Request(`https://relay.test${path}`, init)

const readJson = async response => JSON.parse(await response.text())

class MemoryCache {
  constructor() {
    this.map = new Map()
    this.puts = 0
  }

  async match(request) {
    const cached = this.map.get(request.url)
    return cached ? cached.clone() : undefined
  }

  async put(request, response) {
    this.puts += 1
    this.map.set(request.url, response.clone())
  }
}

const ctx = () => {
  const waits = []
  return {
    waits,
    waitUntil(promise) {
      waits.push(promise)
    },
  }
}

const envelope = (overrides = {}) => ({
  messages: [],
  continuation: "NEXT",
  timeoutMs: 1500,
  ended: false,
  isReplay: false,
  ...overrides,
})

test("OPTIONS and route errors carry CORS JSON responses", async () => {
  const options = await handle(req("/api/livechat", { method: "OPTIONS" }), {}, ctx())
  assert.equal(options.status, 204)
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), "*")

  const method = await handle(req("/api/livechat", { method: "POST" }), {}, ctx())
  assert.equal(method.status, 405)
  assert.equal(method.headers.get("Access-Control-Allow-Origin"), "*")
  assert.deepEqual(await readJson(method), { error: "method not allowed" })

  const missing = await handle(req("/missing"), {}, ctx())
  assert.equal(missing.status, 404)
  assert.deepEqual(await readJson(missing), { error: "not found" })
})

test("health exposes version metadata and optional upstream canary", async () => {
  const shallow = await handle(req("/health"), { SYC_VERSION: "1.2.3" }, ctx(), {
    now: () => new Date("2026-07-05T00:00:00.000Z"),
  })
  assert.equal(shallow.status, 200)
  const shallowBody = await readJson(shallow)
  assert.equal(shallowBody.status, "ok")
  assert.equal(shallowBody.service, "syc-livechat-relay")
  assert.equal(shallowBody.version, "1.2.3")
  assert.equal(shallowBody.innerTubeClientVersion, "2.20240814.00.00")
  assert.equal(shallowBody.timestamp, "2026-07-05T00:00:00.000Z")
  assert.equal("upstream" in shallowBody, false)

  const noCanary = await handle(req("/health?deep=1"), {}, ctx())
  assert.deepEqual((await readJson(noCanary)).upstream, {
    checked: false,
    reason: "canary video not configured",
  })

  const deep = await handle(req("/health?deep=1&video=abc123def45"), {}, ctx(), {
    healthProbe: async videoId => ({ continuation: videoId, isReplay: false }),
  })
  assert.deepEqual((await readJson(deep)).upstream, {
    checked: true,
    ok: true,
    result: { continuation: "abc123def45", isReplay: false },
  })
})

test("validation rejects malformed video, continuation, and offset before upstream", async () => {
  const upstream = async () => {
    throw new Error("must not call upstream")
  }

  for (const [path, error] of [
    ["/api/livechat", "missing video or cont"],
    ["/api/livechat?video=short", "invalid video id"],
    ["/api/livechat?cont=%3Cscript%3E", "invalid cont"],
    [`/api/livechat?cont=${"A".repeat(8193)}`, "cont too long"],
    ["/api/livechat?cont=NEXT&offset=NaN", "invalid offset"],
  ]) {
    const response = await handle(req(path), {}, ctx(), { fetchEnvelope: upstream })
    assert.equal(response.status, 400)
    assert.deepEqual(await readJson(response), { error })
  }
})

test("cache stores live non-terminal responses and returns HIT on repeat", async () => {
  const cache = new MemoryCache()
  const runtime = ctx()
  let calls = 0
  const deps = {
    cache,
    fetchEnvelope: async params => {
      calls += 1
      assert.equal(params.cont, "START")
      assert.equal(params.offset, null)
      return envelope()
    },
  }

  const first = await handle(req("/api/livechat?cont=START"), {}, runtime, deps)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get("X-SYC-Cache"), "MISS")
  assert.equal(first.headers.get("Cache-Control"), "public, s-maxage=1")
  await Promise.all(runtime.waits)
  assert.equal(cache.puts, 1)

  const second = await handle(req("/api/livechat?cont=START"), {}, ctx(), deps)
  assert.equal(second.status, 200)
  assert.equal(second.headers.get("X-SYC-Cache"), "HIT")
  assert.equal(calls, 1)
})

test("cache keys ignore unrelated params and bucket replay offsets", async () => {
  const cache = new MemoryCache()
  const runtime = ctx()
  let calls = 0
  const deps = {
    cache,
    fetchEnvelope: async params => {
      calls += 1
      assert.equal(params.cont, "START")
      assert.equal(params.offset, 3201)
      return envelope({ timeoutMs: 3000 })
    },
  }

  const first = await handle(req("/api/livechat?_=a&offset=3201&cont=START"), {}, runtime, deps)
  assert.equal(first.headers.get("X-SYC-Cache"), "MISS")
  await Promise.all(runtime.waits)

  const second = await handle(req("/api/livechat?cont=START&offset=3999&_=b"), {}, ctx(), deps)
  assert.equal(second.headers.get("X-SYC-Cache"), "HIT")
  assert.equal(calls, 1)
})

test("cold requests for the same normalized key share one in-flight upstream call", async () => {
  const cache = new MemoryCache()
  const inflight = new Map()
  let calls = 0
  let release
  const gate = new Promise(resolve => (release = resolve))
  const deps = {
    cache,
    inflight,
    fetchEnvelope: async () => {
      calls += 1
      await gate
      return envelope({ timeoutMs: 3000 })
    },
  }

  const a = handle(req("/api/livechat?cont=BURST&offset=6100"), {}, ctx(), deps)
  const b = handle(req("/api/livechat?offset=6999&cont=BURST&_ignored=1"), {}, ctx(), deps)
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.headers.get("X-SYC-Inflight"), "HIT")
  assert.equal(calls, 1)
})

test("sub-second and terminal envelopes are not cached", async () => {
  const subSecondCache = new MemoryCache()
  const subSecondCtx = ctx()
  const subSecond = await handle(req("/api/livechat?cont=FAST"), {}, subSecondCtx, {
    cache: subSecondCache,
    fetchEnvelope: async () => envelope({ timeoutMs: 250 }),
  })
  assert.equal(subSecond.headers.get("X-SYC-Cache"), "BYPASS")
  assert.equal(subSecond.headers.get("Cache-Control"), "no-store")
  assert.equal(subSecondCtx.waits.length, 0)
  assert.equal(subSecondCache.puts, 0)

  const terminalCache = new MemoryCache()
  const terminalCtx = ctx()
  const terminal = await handle(req("/api/livechat?cont=DONE"), {}, terminalCtx, {
    cache: terminalCache,
    fetchEnvelope: async () => envelope({ continuation: null, ended: true }),
  })
  assert.equal(terminal.headers.get("X-SYC-Cache"), "BYPASS")
  assert.equal(terminal.headers.get("Cache-Control"), "no-store")
  assert.equal(terminalCtx.waits.length, 0)
  assert.equal(terminalCache.puts, 0)
})

test("upstream failures map to sanitized client errors", async () => {
  const logs = []
  const cache = new MemoryCache()
  const runtime = ctx()
  let calls = 0
  const response = await handle(req("/api/livechat?cont=NEXT"), {}, runtime, {
    cache,
    logError: (...args) => logs.push(args),
    fetchEnvelope: async () => {
      calls += 1
      throw Object.assign(new Error("InnerTube body should stay server-side"), { status: 429 })
    },
  })

  assert.equal(response.status, 429)
  assert.deepEqual(await readJson(response), { error: "rate limited upstream" })
  assert.equal(logs.length, 1)
  assert.equal(response.headers.get("X-SYC-Cache"), "NEGATIVE")
  await Promise.all(runtime.waits)

  const cached = await handle(req("/api/livechat?cont=NEXT&_ignored=1"), {}, ctx(), {
    cache,
    fetchEnvelope: async () => {
      calls += 1
      return envelope()
    },
  })
  assert.equal(cached.status, 429)
  assert.equal(cached.headers.get("X-SYC-Cache"), "HIT")
  assert.equal(calls, 1)
})

test("upstream continuation 4xx maps to immediate re-resolve signal", async () => {
  const response = await handle(req("/api/livechat?cont=STALE"), {}, ctx(), {
    cache: new MemoryCache(),
    logError: () => {},
    fetchEnvelope: async () => {
      throw Object.assign(new Error("gone"), { status: 404 })
    },
  })

  assert.equal(response.status, 410)
  assert.deepEqual(await readJson(response), { error: "stale continuation", reResolve: true })
})
