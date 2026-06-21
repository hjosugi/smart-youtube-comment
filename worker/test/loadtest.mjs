// Load / spike test for the deployed relay.
//
// Usage: node worker/test/loadtest.mjs <relayBase> <videoId>
//
// Measures, against a live high-chat stream:
//   1. sustained throughput (1 viewer)         -> msgs/sec, batch sizes, upstream rate
//   2. cache collapse (staggered viewers)      -> HIT ratio (the IP-ban mitigation)
//   3. thundering herd (cold simultaneous)     -> upstream multiplication on a cold window
//   4. spike (ramped concurrency, warm)        -> latency p50/p95/p99 + error rate
//
// Responsible defaults: same-video requests ride the edge cache, so upstream
// (MISS) volume stays small; we never blast thousands of cache-busted calls.

const base = process.argv[2]
const video = process.argv[3]
if (!base || !video) {
  console.error("usage: node worker/test/loadtest.mjs <relayBase> <videoId>")
  process.exit(2)
}
const ROOT = base.replace(/\/$/, "")

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000 // ms
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(0)
}
const mean = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) : 0)

async function hit(url) {
  const t0 = now()
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } })
    const cache = res.headers.get("X-SYC-Cache") || "-"
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, ms: now() - t0, cache, n: body.messages?.length }
  } catch (e) {
    return { ok: false, status: 0, ms: now() - t0, cache: "ERR", err: e.message }
  }
}

const liveUrl = () => `${ROOT}/api/livechat?video=${video}`
const bustUrl = tag => `${ROOT}/api/livechat?video=${video}&_=${tag}`

// 1) sustained throughput — single viewer polling its own continuation chain
async function sustained(seconds) {
  console.log(`\n[1] sustained throughput — 1 viewer, ${seconds}s`)
  const t0 = now()
  let cont = null
  const seen = new Set()
  const batches = []
  let upstream = 0
  while ((now() - t0) / 1000 < seconds) {
    const url = cont ? `${ROOT}/api/livechat?cont=${encodeURIComponent(cont)}` : liveUrl()
    const res = await fetch(url).then(r => r.json().catch(() => ({})))
    upstream++
    const msgs = res.messages ?? []
    batches.push(msgs.length)
    for (const m of msgs) seen.add(m.id)
    if (res.ended || !res.continuation) break
    cont = res.continuation
    await sleep(Math.min(res.timeoutMs || 1000, 10000))
  }
  const elapsed = (now() - t0) / 1000
  console.log(
    `    unique=${seen.size} rate=${(seen.size / elapsed).toFixed(1)} msg/s  batches=${batches.length} avg=${mean(batches)} max=${Math.max(...batches)} upstreamPolls=${upstream}`,
  )
  return { rate: seen.size / elapsed }
}

// 2) cache collapse — many viewers, staggered across one window, same video
async function collapse(count, spreadMs) {
  console.log(`\n[2] cache collapse — ${count} viewers staggered over ${spreadMs}ms, same video`)
  const tasks = []
  for (let i = 0; i < count; i++) {
    tasks.push(sleep((i / count) * spreadMs).then(() => hit(liveUrl())))
  }
  const res = await Promise.all(tasks)
  const hits = res.filter(r => r.cache === "HIT").length
  const miss = res.filter(r => r.cache === "MISS").length
  console.log(
    `    HIT=${hits} MISS=${miss}  collapse=${((hits / count) * 100).toFixed(0)}%  (MISS = upstream calls)`,
  )
  return { hits, miss }
}

// 3) thundering herd — N simultaneous on a COLD key, then again WARM
async function herd(count) {
  console.log(`\n[3] thundering herd — ${count} simultaneous, cold then warm`)
  const tag = `herd${Math.floor(now())}`
  const cold = await Promise.all(Array.from({ length: count }, () => hit(bustUrl(tag))))
  const warm = await Promise.all(Array.from({ length: count }, () => hit(bustUrl(tag))))
  const cMiss = cold.filter(r => r.cache === "MISS").length
  const wHit = warm.filter(r => r.cache === "HIT").length
  console.log(`    cold: MISS=${cMiss}/${count} (upstream herd)   warm: HIT=${wHit}/${count}`)
  return { coldMiss: cMiss, warmHit: wHit }
}

// 4) spike — ramped concurrency on a WARM key (tests Worker+edge cache throughput)
async function spike(levels) {
  console.log(`\n[4] spike — ramped concurrency (warm key), latency + errors`)
  await hit(liveUrl()) // warm the cache
  await sleep(200)
  for (const c of levels) {
    const res = await Promise.all(Array.from({ length: c }, () => hit(liveUrl())))
    const lat = res.map(r => r.ms)
    const errs = res.filter(r => !r.ok).length
    const hits = res.filter(r => r.cache === "HIT").length
    console.log(
      `    c=${String(c).padStart(3)}  p50=${pct(lat, 50)}ms p95=${pct(lat, 95)}ms p99=${pct(lat, 99)}ms  errors=${errs}  cacheHIT=${hits}/${c}`,
    )
  }
}

async function main() {
  console.log(`load test -> ${ROOT}  video=${video}`)
  const s = await sustained(20)
  await collapse(50, 2500)
  await herd(20)
  await spike([10, 25, 50, 100])
  console.log(`\n[done] measured sustained chat rate ~${s.rate.toFixed(1)} msg/s`)
}
main().catch(e => {
  console.error("loadtest error:", e.message)
  process.exit(1)
})
