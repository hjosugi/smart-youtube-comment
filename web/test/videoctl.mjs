// Pure test for the video-control time formatter (no DOM needed at import time).

import { fmtTime } from "../videoctl.js"

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

assert("zero", fmtTime(0) === "0:00")
assert("seconds pad", fmtTime(7) === "0:07")
assert("under a minute", fmtTime(45) === "0:45")
assert("minutes:seconds", fmtTime(65) === "1:05")
assert("two-digit minutes", fmtTime(605) === "10:05")
assert("hours", fmtTime(3661) === "1:01:01")
assert("hours pad minutes", fmtTime(3600) === "1:00:00")
assert("floors fractional", fmtTime(65.9) === "1:05")
assert("negative -> 0:00", fmtTime(-10) === "0:00")
assert("NaN -> 0:00", fmtTime(NaN) === "0:00")
assert("undefined -> 0:00", fmtTime() === "0:00")

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk ? `\nRESULT: ✅ fmtTime verified (${checks.length} checks)` : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
