// Pure tests for config: parseVideoId across URL shapes + readParams.

import {
  parseVideoId,
  parseStartSeconds,
  parseInput,
  readParams,
  RELAY_DEFAULT,
} from "../config.ts"

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

const ID = "Ec-8stokC_I" // 11 chars incl. - and _

assert("watch?v=", parseVideoId(`https://www.youtube.com/watch?v=${ID}`) === ID)
assert("youtu.be/", parseVideoId(`https://youtu.be/${ID}`) === ID)
assert("/live/", parseVideoId(`https://www.youtube.com/live/${ID}`) === ID)
assert("/embed/", parseVideoId(`https://www.youtube.com/embed/${ID}`) === ID)
assert("/shorts/", parseVideoId(`https://www.youtube.com/shorts/${ID}`) === ID)
assert("bare id", parseVideoId(ID) === ID)
assert(
  "extra query params",
  parseVideoId(`https://www.youtube.com/watch?v=${ID}&t=30s&feature=share`) === ID,
)
assert("v= not first param", parseVideoId(`https://youtube.com/watch?feature=x&v=${ID}`) === ID)
assert("whitespace trimmed", parseVideoId(`  ${ID}  `) === ID)
assert("hyphen+underscore id", parseVideoId("ab-cd_efghi") === "ab-cd_efghi")

assert("invalid: too short", parseVideoId("abc") === "")
assert("invalid: empty", parseVideoId("") === "")
assert("invalid: non-string-ish", parseVideoId(null) === "")
assert("invalid: bare too long", parseVideoId("Ec-8stokC_Ixxxx") === "")
assert("invalid: random url no id", parseVideoId("https://example.com/foo") === "")

// readParams
const p = readParams(`?v=${ID}&mock=1&perf=1`)
assert("readParams: video", p.video === ID)
assert("readParams: mock true", p.mock === true)
assert("readParams: perf true", p.perf === true)
assert("readParams: default relay", readParams("").relay === RELAY_DEFAULT)
assert("readParams: custom relay", readParams("?relay=https://r.dev").relay === "https://r.dev")
assert("readParams: mock default false", readParams("?v=" + ID).mock === false)
assert("readParams: empty video for junk", readParams("?v=junk").video === "")

// start-time parsing (t= / start=)
assert("start: plain seconds", parseStartSeconds(`https://youtu.be/${ID}?t=90`) === 90)
assert("start: s suffix", parseStartSeconds(`watch?v=${ID}&t=9938s`) === 9938)
assert("start: h/m/s", parseStartSeconds(`watch?v=${ID}&t=1h2m3s`) === 3723)
assert("start: start= param", parseStartSeconds(`?v=${ID}&start=120`) === 120)
assert("start: none -> 0", parseStartSeconds(`watch?v=${ID}`) === 0)
assert(
  "parseInput: video + start",
  (() => {
    const r = parseInput(`https://www.youtube.com/watch?v=${ID}&t=30s`)
    return r.video === ID && r.start === 30
  })(),
)
assert("readParams: start from &t=", readParams(`?v=${ID}&t=42`).start === 42)
assert("readParams: start default 0", readParams(`?v=${ID}`).start === 0)

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk ? `\nRESULT: ✅ config verified (${checks.length} checks)` : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
