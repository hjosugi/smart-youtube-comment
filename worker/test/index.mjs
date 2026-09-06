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
  assert.equal(shallowBody.defaultInnerTubeClientVersion, "2.20240814.00.00")
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

  let probedConfig
  const override = await handle(
    req("/health?deep=1&video=abc123def45"),
    { INNERTUBE_CLIENT_VERSION: "2.20260705.00.00" },
    ctx(),
    {
      healthProbe: async (_videoId, config) => {
        probedConfig = config
        return { ok: true }
      },
    },
  )
  const overrideBody = await readJson(override)
  assert.equal(overrideBody.innerTubeClientVersion, "2.20260705.00.00")
  assert.equal(probedConfig.clientVersion, "2.20260705.00.00")
})

test("validation rejects malformed video, continuation, and offset before upstream", async () => {
  const upstream = async () => {
    throw new Error("must not call upstream")
  }

  for (const [path, error] of [
    ["/api/livechat", "missing video or cont"],
    ["/api/livechat?video=short", "invalid video id"],
    ["/api/livechat?cont=%3Cscript%3E", "invalid cont"],
    ["/api/livechat?cont=NEXT%253Cscript%253E", "invalid cont"],
    ["/api/livechat?cont=NEXT%250A", "invalid cont"],
    ["/api/livechat?cont=NEXT%25", "invalid cont"],
    ["/api/livechat?cont=NEXT%253G", "invalid cont"],
    ["/api/livechat?cont=NEXT%25253D", "invalid cont"],
    [`/api/livechat?cont=${"A".repeat(8193)}`, "cont too long"],
    [`/api/livechat?cont=${"A".repeat(8191)}%253D`, "cont too long"],
    ["/api/livechat?cont=NEXT&offset=NaN", "invalid offset"],
    ["/api/livechat?cont=NEXT&offset=3000", "offset requires replay=1"],
  ]) {
    const response = await handle(req(path), {}, ctx(), { fetchEnvelope: upstream })
    assert.equal(response.status, 400)
    assert.deepEqual(await readJson(response), { error })
  }
})

test("returned escaped continuations can be polled and share the decoded cache key", async () => {
  let calls = 0
  const deps = {
    cache: new MemoryCache(),
    fetchEnvelope: async params => {
      calls += 1
      if (params.video) return envelope({ continuation: "NEXT%3D%3D" })
      assert.equal(params.cont, "NEXT==")
      return envelope({ continuation: "AFTER" })
    },
  }

  const initial = await handle(req("/api/livechat?video=abc123def45"), {}, ctx(), deps)
  const token = (await readJson(initial)).continuation
  const pollContext = ctx()
  const poll = await handle(
    req(`/api/livechat?cont=${encodeURIComponent(token)}`),
    {},
    pollContext,
    deps,
  )
  assert.equal(poll.status, 200)
  assert.equal((await readJson(poll)).continuation, "AFTER")
  await Promise.all(pollContext.waits)

  for (const equivalentToken of ["NEXT==", "NEXT%3d%3d"]) {
    const cached = await handle(
      req(`/api/livechat?cont=${encodeURIComponent(equivalentToken)}`),
      {},
      ctx(),
      deps,
    )
    assert.equal(cached.status, 200)
    assert.equal(cached.headers.get("X-SYC-Cache"), "HIT")
  }
  assert.equal(calls, 2)
})

test("configured origin allowlist rejects browser callers outside the list", async () => {
  const blocked = await handle(
    req("/api/livechat?video=abc123def45", { headers: { Origin: "https://evil.example" } }),
    { ALLOWED_ORIGINS: "https://app.example" },
    ctx(),
  )
  assert.equal(blocked.status, 403)
  assert.deepEqual(await readJson(blocked), { error: "origin not allowed" })

  let called = false
  const allowed = await handle(
    req("/api/livechat?video=abc123def45", { headers: { Origin: "https://app.example" } }),
    { ALLOWED_ORIGINS: "https://app.example" },
    ctx(),
    {
      cache: new MemoryCache(),
      fetchEnvelope: async () => {
        called = true
        return envelope()
      },
    },
  )
  assert.equal(allowed.status, 200)
  assert.equal(called, true)
})

test("per-client rate limit returns 429 before upstream", async () => {
  let calls = 0
  const deps = {
    cache: new MemoryCache(),
    fetchEnvelope: async () => {
      calls += 1
      return envelope({ timeoutMs: 250 })
    },
  }
  const init = { headers: { "CF-Connecting-IP": "198.51.100.44" } }
  const first = await handle(
    req("/api/livechat?video=abc123def45", init),
    { RATE_LIMIT_PER_MINUTE: "1" },
    ctx(),
    deps,
  )
  const second = await handle(
    req("/api/livechat?video=def456abc78", init),
    { RATE_LIMIT_PER_MINUTE: "1" },
    ctx(),
    deps,
  )
  assert.equal(first.status, 200)
  assert.equal(second.status, 429)
  assert.deepEqual(await readJson(second), { error: "rate limited" })
  assert.equal(second.headers.get("X-SYC-RateLimit-Limit"), "1")
  assert.equal(calls, 1)
})

test("livechat responses emit structured cache and upstream metrics", async () => {
  const cache = new MemoryCache()
  const runtime = ctx()
  const metrics = []
  const response = await handle(req("/api/livechat?cont=METRIC"), {}, runtime, {
    cache,
    logMetric: metric => metrics.push(metric),
    fetchEnvelope: async (_params, config) => {
      config.metrics.attempts = 2
      config.metrics.retries = 1
      return envelope({ messages: [{ id: "m1" }] })
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("X-SYC-Upstream-Attempts"), "2")
  assert.equal(response.headers.get("X-SYC-Upstream-Retries"), "1")
  await Promise.all(runtime.waits)
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].event, "livechat")
  assert.equal(metrics[0].cache, "MISS")
  assert.equal(metrics[0].upstreamAttempts, 2)
  assert.equal(metrics[0].upstreamRetries, 1)
})

test("cache stores live non-terminal responses and returns HIT on repeat", async () => {
  const cache = new MemoryCache()
  const runtime = ctx()
  let calls = 0
  let clientConfig
  const deps = {
    cache,
    fetchEnvelope: async (params, config) => {
      calls += 1
      clientConfig = config
      assert.equal(params.cont, "START")
      assert.equal(params.offset, null)
      return envelope()
    },
  }

  const first = await handle(
    req("/api/livechat?cont=START"),
    { INNERTUBE_CLIENT_VERSION: "2.20260705.00.00" },
    runtime,
    deps,
  )
  assert.equal(first.status, 200)
  assert.equal(first.headers.get("X-SYC-Cache"), "MISS")
  assert.equal(first.headers.get("Cache-Control"), "public, s-maxage=1")
  await Promise.all(runtime.waits)
  assert.equal(cache.puts, 1)
  assert.equal(clientConfig.clientVersion, "2.20260705.00.00")

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

  const first = await handle(
    req("/api/livechat?_=a&replay=1&offset=3201&cont=START"),
    {},
    runtime,
    deps,
  )
  assert.equal(first.headers.get("X-SYC-Cache"), "MISS")
  await Promise.all(runtime.waits)

  const second = await handle(
    req("/api/livechat?cont=START&replay=1&offset=3999&_=b"),
    {},
    ctx(),
    deps,
  )
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

  const a = handle(req("/api/livechat?cont=BURST&replay=1&offset=6100"), {}, ctx(), deps)
  const b = handle(req("/api/livechat?replay=1&offset=6999&cont=BURST&_ignored=1"), {}, ctx(), deps)
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
  assert.equal(subSecondCache.puts, 0)

  const terminalCache = new MemoryCache()
  const terminalCtx = ctx()
  const terminal = await handle(req("/api/livechat?cont=DONE"), {}, terminalCtx, {
    cache: terminalCache,
    fetchEnvelope: async () => envelope({ continuation: null, ended: true }),
  })
  assert.equal(terminal.headers.get("X-SYC-Cache"), "BYPASS")
  assert.equal(terminal.headers.get("Cache-Control"), "no-store")
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
