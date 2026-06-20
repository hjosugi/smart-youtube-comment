// Deterministic (offline) test of the adaptive backoff logic in chat-client.js.
// Injects a scripted fake `fetch` to drive failures/recoveries and asserts:
//   1. consecutive failures grow the backoff exponentially
//   2. a success resets cadence to the server timeoutMs
//   3. after `reResolveAfter` failures the client re-resolves from videoId
//   4. an `ended` envelope stops the loop
// No network. jitterRatio:0 for exact assertions.

import { createLiveChatClient } from "../chat-client.js";

function fakeResponse(ok, status, data) {
  return { ok, status, json: async () => data };
}

// Scripted queue of responses, in fetch-call order.
const SCRIPT = [
  fakeResponse(true, 200, { messages: [{ id: "a" }], continuation: "c1", timeoutMs: 20, ended: false }), // resolve ok
  fakeResponse(false, 502, { error: "boom1" }), // fail 1
  fakeResponse(false, 502, { error: "boom2" }), // fail 2
  fakeResponse(false, 502, { error: "boom3" }), // fail 3 -> triggers re-resolve
  fakeResponse(true, 200, { messages: [{ id: "b" }], continuation: "c2", timeoutMs: 20, ended: false }), // recover
  fakeResponse(true, 200, { messages: [{ id: "c" }], continuation: null, ended: true }), // ended
];

const calls = []; // record which param each fetch used
let i = 0;
globalThis.fetch = async (url) => {
  const u = url instanceof URL ? url : new URL(url);
  calls.push(u.searchParams.has("cont") ? "cont" : u.searchParams.has("video") ? "video" : "none");
  const r = SCRIPT[i++];
  if (!r) return fakeResponse(true, 200, { messages: [], continuation: null, ended: true });
  return r;
};

const states = [];
const errors = [];
const messages = [];
let endedReason = null;

const client = createLiveChatClient({
  base: "http://fake",
  backoffBase: 50,
  backoffFactor: 2,
  jitterRatio: 0,
  minIntervalMs: 10,
  reResolveAfter: 3,
  requestTimeoutMs: 1000,
});

await client.start("VIDEOIDXXXX", {
  onMessages: (m) => messages.push(...m.map((x) => x.id)),
  onState: (s) => states.push(s),
  onError: (e, n) => errors.push({ status: e.status, n }),
  onEnded: (info) => (endedReason = info.reason),
});

// --- assertions ---
const fails = states.filter((s) => !s.healthy).map((s) => s.nextInMs);
const checks = [];
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra });

assert("got 3 errors", errors.length === 3, JSON.stringify(errors));
assert("backoff grows 50<100<200", fails.length === 3 && fails[0] === 50 && fails[1] === 100 && fails[2] === 200, JSON.stringify(fails));
assert("call sequence re-resolves after 3 fails", calls.join(",") === "video,cont,cont,cont,video,cont", calls.join(","));
assert("recovered to healthy cadence 20ms", states.some((s) => s.healthy && s.nextInMs === 20), JSON.stringify(states.filter((s) => s.healthy).map((s) => s.nextInMs)));
assert("messages a,b,c delivered", messages.join(",") === "a,b,c", messages.join(","));
assert("ended stopped the loop", endedReason === "ended", String(endedReason));

let allOk = true;
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`);
  if (!c.ok) allOk = false;
}
console.log(allOk ? "\nRESULT: ✅ adaptive backoff logic verified" : "\nRESULT: ❌ FAILURES above");
process.exit(allOk ? 0 : 1);
