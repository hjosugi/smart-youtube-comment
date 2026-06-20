// Pure test: the localStorage chrome-shim (store.js) lets the reused extension
// settings.js + filter.js work unchanged. Uses a Map-backed localStorage stub.
// Dynamic imports so the stub is installed before store.js runs.

const mem = new Map();
const target = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.localStorage = new Proxy(target, {
  ownKeys: () => [...mem.keys()],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  get: (t, p) => (typeof t[p] === "function" ? t[p].bind(t) : mem.has(p) ? mem.get(p) : t[p]),
});

await import("../store.js"); // installs globalThis.chrome.storage over localStorage
await import("../settings.js");
await import("../filter.js");
const S = globalThis.SYCSettings;
const F = globalThis.SYCFilter;

const checks = [];
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra });

// --- store shim: roundtrip + change events ---
{
  let fired = null;
  chrome.storage.onChanged.addListener((changes) => (fired = changes));
  await chrome.storage.local.set({ "t:k": { a: 1 } });
  const got = await chrome.storage.local.get("t:k");
  assert("store: set/get roundtrip", JSON.stringify(got["t:k"]) === '{"a":1}');
  assert("store: onChanged fired with newValue", fired?.["t:k"]?.newValue?.a === 1);
  await chrome.storage.local.remove("t:k");
  assert("store: remove clears", (await chrome.storage.local.get("t:k"))["t:k"] === undefined);
}

// --- settings: defaults, normalize/clamp, save<->load, engine mapping ---
{
  const def = await S.load();
  assert("settings: defaults load", def.speedPct === 100 && def.enabled === true);

  await S.save({ ...def, opacity: 999, speedPct: 33, fontPx: 30 });
  const loaded = await S.load();
  assert("settings: opacity clamped to 100", loaded.opacity === 100, String(loaded.opacity));
  assert("settings: speedPct clamped to >=50", loaded.speedPct === 50, String(loaded.speedPct));
  assert("settings: persisted fontPx", loaded.fontPx === 30);

  const eng = S.toEngineConfig({ ...def, speedPct: 200, opacity: 50 });
  assert("settings: speed%->durationScale", Math.abs(eng.durationScale - 0.5) < 1e-9, String(eng.durationScale));
  assert("settings: opacity%->0..1", eng.opacity === 0.5);
  assert("settings: tierDurations array", Array.isArray(eng.tierDurations) && eng.tierDurations.length === 3);
}

// --- filter: NG user (exact) + NG word (Aho-Corasick substring), normalized ---
{
  await F.save({ users: ["@SpamBot", " Troll "], words: ["discord.gg/", "草草草草"] });
  assert("filter: NG user exact (normalized case)", F.shouldDrop("@spambot", "hello") === true);
  assert("filter: NG user trimmed", F.shouldDrop("troll", "hi") === true);
  assert("filter: NG word substring match", F.shouldDrop("@ok", "join discord.gg/xyz now") === true);
  assert("filter: NG word unicode", F.shouldDrop("@ok", "うぽつ 草草草草草") === true);
  assert("filter: clean message passes", F.shouldDrop("@alice", "great stream today") === false);

  const reloaded = await new Promise((r) => setTimeout(async () => r(await F.load()), 0));
  assert("filter: lists persisted", reloaded.users.includes("@spambot") && reloaded.words.includes("discord.gg/"));
}

let allOk = true;
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`);
  if (!c.ok) allOk = false;
}
console.log(allOk ? `\nRESULT: ✅ store + settings + filter verified (${checks.length} checks)` : "\nRESULT: ❌ FAILURES");
process.exit(allOk ? 0 : 1);
