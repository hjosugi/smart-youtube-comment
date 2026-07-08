import { HISTORY_KEY, loadViewingHistory, rememberViewing, watchUrl } from "../history.ts"

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

const storage = {
  data: new Map(),
  getItem(key) {
    return this.data.has(key) ? this.data.get(key) : null
  },
  setItem(key, value) {
    this.data.set(key, String(value))
  },
}

const A = "Ec-8stokC_I"
const B = "ab-cd_efghi"
const C = "12345678901"

rememberViewing({ video: A, title: "First", positionSeconds: 12 }, { storage, max: 3 })
rememberViewing({ video: B, title: "Second", positionSeconds: 0 }, { storage, max: 3 })
rememberViewing({ video: A, title: "First updated", positionSeconds: 45 }, { storage, max: 3 })
let rows = loadViewingHistory(storage)

assert("history de-dupes by video", rows.length === 2 && rows[0].video === A)
assert(
  "history keeps latest title and position",
  rows[0].title === "First updated" && rows[0].positionSeconds === 45,
)
assert(
  "watchUrl includes t= when position exists",
  watchUrl(rows[0]) === `https://www.youtube.com/watch?v=${A}&t=45s`,
)
assert("watchUrl omits t= for zero", watchUrl(rows[1]) === `https://www.youtube.com/watch?v=${B}`)

rememberViewing({ video: C, title: "Third", positionSeconds: 3 }, { storage, max: 2 })
rows = loadViewingHistory(storage)
assert("history honors max size", rows.length === 2 && rows[0].video === C && rows[1].video === A)

storage.setItem(HISTORY_KEY, JSON.stringify([{ video: "bad" }, { video: B, title: "ok" }]))
rows = loadViewingHistory(storage)
assert("history drops invalid entries", rows.length === 1 && rows[0].video === B)

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk ? `\nRESULT: ✅ history verified (${checks.length} checks)` : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
