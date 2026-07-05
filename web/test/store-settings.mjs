// Pure test: the localStorage chrome-shim (store.js) lets the reused extension
// settings.js + filter.js work unchanged. Uses a Map-backed localStorage stub.
// Dynamic imports so the stub is installed before store.js runs.

const mem = new Map()
const target = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: k => void mem.delete(k),
  clear: () => mem.clear(),
}
globalThis.localStorage = new Proxy(target, {
  ownKeys: () => [...mem.keys()],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  get: (t, p) => (typeof t[p] === "function" ? t[p].bind(t) : mem.has(p) ? mem.get(p) : t[p]),
})

const eventListeners = new Map()
globalThis.addEventListener = (type, cb) => {
  const list = eventListeners.get(type) ?? []
  list.push(cb)
  eventListeners.set(type, list)
}
globalThis.dispatchEvent = event => {
  for (const cb of eventListeners.get(event.type) ?? []) cb.call(globalThis, event)
  return true
}

await import("../store.js") // installs globalThis.chrome.storage over localStorage
await import("../settings.js")
await import("../filter.js")
const S = globalThis.SYCSettings
const F = globalThis.SYCFilter

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

// --- store shim: roundtrip + change events ---
{
  let fired = null
  chrome.storage.onChanged.addListener(changes => (fired = changes))
  await chrome.storage.local.set({ "t:k": { a: 1 } })
  const got = await chrome.storage.local.get("t:k")
  assert("store: set/get roundtrip", JSON.stringify(got["t:k"]) === '{"a":1}')
  assert("store: onChanged fired with newValue", fired?.["t:k"]?.newValue?.a === 1)
  await chrome.storage.local.remove("t:k")
  assert("store: remove clears", (await chrome.storage.local.get("t:k"))["t:k"] === undefined)
}

// --- store shim: cross-tab storage events fan out as chrome onChanged events ---
{
  let fired = null
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (changes["tab:k"]) fired = { changes, areaName }
  })
  globalThis.dispatchEvent({
    type: "storage",
    key: "tab:k",
    oldValue: JSON.stringify({ old: true }),
    newValue: JSON.stringify({ next: 2 }),
  })
  assert(
    "store: storage event emits parsed old/new values",
    fired?.areaName === "local" &&
      fired.changes["tab:k"].oldValue.old === true &&
      fired.changes["tab:k"].newValue.next === 2,
    JSON.stringify(fired),
  )

  let removed = null
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (changes["tab:removed"]) removed = { changes, areaName }
  })
  globalThis.dispatchEvent({
    type: "storage",
    key: "tab:removed",
    oldValue: JSON.stringify(["gone"]),
    newValue: null,
  })
  assert(
    "store: storage event remove maps null to undefined",
    removed?.areaName === "local" &&
      Array.isArray(removed.changes["tab:removed"].oldValue) &&
      removed.changes["tab:removed"].newValue === undefined,
    JSON.stringify(removed),
  )
}

// --- settings: defaults, normalize/clamp, save<->load, engine mapping ---
{
  const def = await S.load()
  assert("settings: defaults load", def.speedPct === 100 && def.enabled === true)
  assert("settings: web profile", S.PROFILE.surface === "web" && S.PROFILE.target === "mobile PWA")
  assert("settings: web profile rationale", /Mobile/.test(S.PROFILE.rationale))
  assert(
    "settings: mobile density defaults",
    S.DEFAULTS.fontPx === 18 &&
      S.DEFAULTS.maxActive === 250 &&
      S.DEFAULTS.maxQueue === 1000 &&
      S.DEFAULTS.spawnPerFrame === 6 &&
      S.DEFAULTS.renderScalePct === 60 &&
      S.DEFAULTS.lineHeight === 24 &&
      S.DEFAULTS.dedup === true,
  )

  await S.save({ ...def, opacity: 999, speedPct: 33, fontPx: 30 })
  const loaded = await S.load()
  assert("settings: opacity clamped to 100", loaded.opacity === 100, String(loaded.opacity))
  assert("settings: speedPct clamped to >=50", loaded.speedPct === 50, String(loaded.speedPct))
  assert("settings: persisted fontPx", loaded.fontPx === 30)

  const eng = S.toEngineConfig({ ...def, speedPct: 200, opacity: 50 })
  assert(
    "settings: speed%->durationScale",
    Math.abs(eng.durationScale - 0.5) < 1e-9,
    String(eng.durationScale),
  )
  assert("settings: opacity%->0..1", eng.opacity === 0.5)
  assert(
    "settings: tierDurations array",
    Array.isArray(eng.tierDurations) && eng.tierDurations.length === 3,
  )
}

// --- filter: NG user (exact) + NG word (Aho-Corasick substring), normalized ---
{
  await F.save({ users: ["@SpamBot", " Troll "], words: ["discord.gg/", "草草草草"] })
  assert("filter: NG user exact (normalized case)", F.shouldDrop("@spambot", "hello") === true)
  assert("filter: NG user trimmed", F.shouldDrop("troll", "hi") === true)
  assert("filter: NG word substring match", F.shouldDrop("@ok", "join discord.gg/xyz now") === true)
  assert("filter: NG word unicode", F.shouldDrop("@ok", "うぽつ 草草草草草") === true)
  assert("filter: clean message passes", F.shouldDrop("@alice", "great stream today") === false)

  const reloaded = await new Promise(r => setTimeout(async () => r(await F.load()), 0))
  assert(
    "filter: lists persisted",
    reloaded.users.includes("@spambot") && reloaded.words.includes("discord.gg/"),
  )
}

// --- store: multi-key get, get-all, array values ---
{
  await chrome.storage.local.set({ "m:1": 1, "m:2": [3, 4] })
  const multi = await chrome.storage.local.get(["m:1", "m:2"])
  assert("store: get multiple keys", multi["m:1"] === 1 && JSON.stringify(multi["m:2"]) === "[3,4]")
  const all = await chrome.storage.local.get(null)
  assert("store: get-all enumerates keys", "m:1" in all && "m:2" in all)
}

// --- settings: normalize edge cases (types, ranges, selects) ---
{
  assert("settings: bool from 'false' string", S.normalize({ enabled: "false" }).enabled === false)
  assert("settings: bool from 1", S.normalize({ enabled: 1 }).enabled === true)
  assert(
    "settings: select invalid -> default",
    S.normalize({ fontFamily: "nonsense" }).fontFamily === "",
  )
  assert(
    "settings: range step rounding (117->120)",
    S.normalize({ speedPct: 117 }).speedPct === 120,
  )
  assert("settings: range over-max clamps", S.normalize({ fontPx: 999 }).fontPx === 48)
  assert(
    "settings: range non-numeric -> default",
    S.normalize({ maxActive: "abc" }).maxActive === S.DEFAULTS.maxActive,
  )
  assert(
    "settings: listEnabled in schema",
    "listEnabled" in S.DEFAULTS && S.DEFAULTS.listEnabled === true,
  )
}

// --- filter: cleanList, empties, overlapping words ---
{
  assert(
    "filter: cleanList dedups+normalizes",
    JSON.stringify(F.cleanList(["A", " a ", "B", ""])) === JSON.stringify(["a", "b"]),
  )
  await F.save({ users: [], words: [] })
  assert("filter: empty lists never drop", F.shouldDrop("@anyone", "anything at all") === false)
  await F.save({ users: [], words: ["abc", "abcdef"] })
  assert(
    "filter: overlapping words both match",
    F.shouldDrop("@x", "zzabcdefzz") === true && F.shouldDrop("@x", "qabcq") === true,
  )
  assert("filter: stats reflect lists", F.stats().words === 2)
}

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk
    ? `\nRESULT: ✅ store + settings + filter verified (${checks.length} checks)`
    : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
