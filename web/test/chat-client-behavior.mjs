// Behavioral tests for the effectful chat-client: pause/resume halt and resume
// polling, refresh() polls immediately, and replay mode sends the player offset.
// Uses a fake fetch that records requests; timing margins kept generous.

import { createLiveChatClient } from "../chat-client.ts"

const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

let calls = []
let mode = "live"
globalThis.fetch = async url => {
  const u = url instanceof URL ? url : new URL(url)
  calls.push({
    cont: u.searchParams.get("cont"),
    video: u.searchParams.get("video"),
    offset: u.searchParams.get("offset"),
  })
  const env = {
    messages: [{ id: "m" + calls.length }],
    continuation: "c",
    timeoutMs: 40,
    ended: false,
    isReplay: mode === "replay",
  }
  return { ok: true, status: 200, json: async () => env }
}

// --- pause halts polling; resume continues ---
{
  calls = []
  mode = "live"
  const c = createLiveChatClient({
    base: "http://x",
    minIntervalMs: 20,
    quietThreshold: 0,
    jitterRatio: 0,
  })
  c.start("VIDEOIDXXXX", {})
  await sleep(140)
  const running = calls.length
  c.pause()
  await sleep(160)
  const paused = calls.length
  c.resume()
  await sleep(140)
  const resumed = calls.length
  c.stop()
  assert("polls while running", running >= 2, `running=${running}`)
  assert("pause halts (<=1 in-flight after)", paused - running <= 1, `delta=${paused - running}`)
  assert("resume continues", resumed - paused >= 2, `delta=${resumed - paused}`)
}

// --- refresh() polls immediately instead of waiting out a long interval ---
{
  calls = []
  mode = "live"
  const c = createLiveChatClient({ base: "http://x", minIntervalMs: 5000, quietThreshold: 0 })
  c.start("VIDEOIDXXXX", {})
  await sleep(60) // first poll fires immediately, then naps ~5s
  const n1 = calls.length
  c.refresh()
  await sleep(60)
  const n2 = calls.length
  c.stop()
  assert("first poll is immediate", n1 >= 1, `n1=${n1}`)
  assert("refresh triggers an immediate re-poll", n2 > n1, `n1=${n1} n2=${n2}`)
}

// --- replay mode sends the player offset on polls ---
{
  calls = []
  mode = "replay"
  const c = createLiveChatClient({
    base: "http://x",
    minIntervalMs: 20,
    quietThreshold: 0,
    getOffsetMs: () => 42000,
  })
  c.start("VIDEOIDXXXX", {})
  await sleep(140)
  c.stop()
  const contCalls = calls.filter(x => x.cont)
  assert(
    "replay: first poll resolves the video",
    calls[0].video === "VIDEOIDXXXX" && calls[0].offset === null,
  )
  assert(
    "replay: subsequent polls carry offset",
    contCalls.length >= 1 && contCalls.every(x => x.offset === "42000"),
    JSON.stringify(contCalls.slice(0, 3)),
  )
}

// --- stop() ends the loop (no more polls) ---
{
  calls = []
  mode = "live"
  const c = createLiveChatClient({ base: "http://x", minIntervalMs: 20, quietThreshold: 0 })
  c.start("VIDEOIDXXXX", {})
  await sleep(80)
  c.stop()
  const atStop = calls.length
  await sleep(120)
  c.stop()
  assert("stop halts polling", calls.length - atStop <= 1, `grew by ${calls.length - atStop}`)
}

// --- stale continuation 410 immediately re-resolves from videoId ---
{
  calls = []
  const responses = [
    { ok: true, status: 200, body: { messages: [], continuation: "stale", timeoutMs: 20 } },
    { ok: false, status: 410, body: { error: "stale continuation", reResolve: true } },
    { ok: true, status: 200, body: { messages: [], continuation: null, ended: true } },
  ]
  globalThis.fetch = async url => {
    const u = url instanceof URL ? url : new URL(url)
    calls.push({
      cont: u.searchParams.get("cont"),
      video: u.searchParams.get("video"),
      offset: u.searchParams.get("offset"),
    })
    const response = responses.shift()
    return { ok: response.ok, status: response.status, json: async () => response.body }
  }

  const errors = []
  let endedReason = null
  const c = createLiveChatClient({
    base: "http://x",
    minIntervalMs: 20,
    quietThreshold: 0,
    jitterRatio: 0,
    reResolveAfter: 99,
  })
  await c.start("VIDEOIDXXXX", {
    onError: (e, n) => errors.push({ status: e.status, n }),
    onEnded: info => (endedReason = info.reason),
  })
  assert(
    "410 stale continuation re-resolves immediately",
    calls.map(x => (x.cont ? "cont" : x.video ? "video" : "none")).join(",") === "video,cont,video",
    JSON.stringify(calls),
  )
  assert(
    "410 stale continuation reports one error",
    errors.length === 1 && errors[0].status === 410,
  )
  assert("410 recovery reaches terminal envelope", endedReason === "ended", String(endedReason))
}

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk
    ? `\nRESULT: ✅ chat-client behavior verified (${checks.length} checks)`
    : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
