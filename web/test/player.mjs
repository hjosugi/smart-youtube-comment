// Pure test for YouTube player state mapping. Unknown states such as -1
// (unstarted) must be treated as non-playing so chat polling stays paused.

import { mountPlayer } from "../player.ts"

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

let optionsSeen = null
globalThis.YT = {
  Player: function Player(_elementId, options) {
    optionsSeen = options
    const player = {}
    setTimeout(() => options.events?.onReady?.({ target: player }), 0)
    return player
  },
}

const states = []
await mountPlayer("player", "VIDEOIDXXXX", state => states.push(state))

optionsSeen.events.onStateChange({ data: 1 })
optionsSeen.events.onStateChange({ data: 2 })
optionsSeen.events.onStateChange({ data: 3 })
optionsSeen.events.onStateChange({ data: 5 })
optionsSeen.events.onStateChange({ data: 0 })
optionsSeen.events.onStateChange({ data: -1 })
optionsSeen.events.onStateChange({ data: 999 })

assert(
  "known states map to expected playback names",
  JSON.stringify(states.slice(0, 5)) ===
    JSON.stringify(["playing", "paused", "playing", "paused", "ended"]),
  JSON.stringify(states),
)
assert(
  "unknown states fall back to paused",
  states[5] === "paused" && states[6] === "paused",
  JSON.stringify(states),
)

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk
    ? `\nRESULT: ✅ player state mapping verified (${checks.length} checks)`
    : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
