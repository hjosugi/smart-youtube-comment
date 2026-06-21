// Pure test: the lifecycle helpers degrade gracefully when the APIs are absent
// (as in Node — no wakeLock, no MediaMetadata). They must never throw.

import { createWakeLock, setMediaSession } from "../lifecycle.js"

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

const wl = createWakeLock()
assert("wakeLock reports unsupported in node", wl.supported === false)
assert("wakeLock starts inactive", wl.active === false)

let threw = false
try {
  await wl.acquire() // no-op when unsupported
  await wl.release()
} catch {
  threw = true
}
assert("acquire/release never throw", !threw)
assert("still inactive after no-op acquire", wl.active === false)

assert("setMediaSession returns false when unsupported", setMediaSession({ title: "x" }) === false)

let threw2 = false
try {
  setMediaSession() // no args, unsupported env
} catch {
  threw2 = true
}
assert("setMediaSession never throws", !threw2)

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk
    ? `\nRESULT: ✅ lifecycle degrades gracefully (${checks.length} checks)`
    : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
