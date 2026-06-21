// Pure tests for playback gating (makeFate) + seek detection (isSeek).
// This is the heart of replay/VOD behavior, so it gets exhaustive coverage.

import { makeFate, isSeek } from "../playback.ts"

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

// ---- makeFate: live (no offsetMs) ----
{
  const seen = new Set()
  const fate = makeFate({ seen, shouldDrop: (a, t) => a === "@ng" || t.includes("badword") })

  assert(
    "live: new message shows",
    fate({ id: "1", author: "@a", text: "hi" }, Infinity) === "show",
  )
  seen.add("1")
  assert(
    "live: duplicate id drops",
    fate({ id: "1", author: "@a", text: "hi" }, Infinity) === "drop",
  )
  assert("NG author drops", fate({ id: "2", author: "@ng", text: "x" }, Infinity) === "drop")
  assert(
    "NG word drops",
    fate({ id: "3", author: "@a", text: "a badword here" }, Infinity) === "drop",
  )
  assert(
    "NG checked before dedup",
    fate({ id: "1", author: "@ng", text: "x" }, Infinity) === "drop",
  )
}

// ---- makeFate: replay window gating ----
{
  const fate = makeFate({ seen: new Set(), shouldDrop: () => false }) // lead 1500, lag 8000
  const now = 120000
  assert("replay: future -> skip", fate({ id: "a", offsetMs: 130000 }, now) === "skip") // 130000 > 121500
  assert("replay: within lead -> show", fate({ id: "b", offsetMs: 121000 }, now) === "show")
  assert("replay: boundary +lead -> show", fate({ id: "c", offsetMs: 121500 }, now) === "show")
  assert("replay: just over lead -> skip", fate({ id: "d", offsetMs: 121501 }, now) === "skip")
  assert("replay: recent past -> show", fate({ id: "e", offsetMs: 115000 }, now) === "show")
  assert("replay: boundary -lag -> show", fate({ id: "f", offsetMs: 112000 }, now) === "show")
  assert("replay: stale backlog -> drop", fate({ id: "g", offsetMs: 111999 }, now) === "drop")
}

// future message is re-evaluated (skip doesn't consume it) and shows when due
{
  const fate = makeFate({ seen: new Set(), shouldDrop: () => false })
  const m = { id: "z", offsetMs: 130000 }
  assert(
    "replay: skip now then show when due",
    fate(m, 120000) === "skip" && fate(m, 130000) === "show",
  )
}

// custom lead/lag = exact-now-only gating
{
  const fate = makeFate({ seen: new Set(), shouldDrop: () => false, leadMs: 0, lagMs: 0 })
  assert("tight window: exact now shows", fate({ id: "1", offsetMs: 5000 }, 5000) === "show")
  assert("tight window: +1ms skips", fate({ id: "2", offsetMs: 5001 }, 5000) === "skip")
  assert("tight window: -1ms drops", fate({ id: "3", offsetMs: 4999 }, 5000) === "drop")
}

// ---- isSeek ----
assert("isSeek: normal play -> false", isSeek(700, 700) === false)
assert("isSeek: minor drift -> false", isSeek(1200, 700) === false) // |500| < 2000
assert("isSeek: forward seek -> true", isSeek(30000, 700) === true)
assert("isSeek: backward seek -> true", isSeek(-20000, 700) === true)
assert(
  "isSeek: long pause looks like seek -> true (app gates on `playing`)",
  isSeek(0, 3000) === true,
)
assert("isSeek: exactly threshold -> false (strict >)", isSeek(2700, 700) === false) // |2000| not > 2000
assert("isSeek: just over threshold -> true", isSeek(2701, 700) === true)
assert("isSeek: custom threshold", isSeek(1500, 0, 1000) === true && isSeek(800, 0, 1000) === false)

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk
    ? `\nRESULT: ✅ playback gating + seek verified (${checks.length} checks)`
    : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
