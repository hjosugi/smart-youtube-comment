// Pure unit test of the chat-client state machine (`_pure.step`).
// No fetch, no timers — just data -> data. This is the payoff of separating the
// adaptive logic from effects.

import { _pure } from "../chat-client.js";

const cfg = {
  minIntervalMs: 800,
  maxIntervalMs: 30000,
  backoffBase: 1000,
  backoffFactor: 2,
  reResolveAfter: 3,
  maxConsecutiveFailures: 5,
};
const step = _pure.step(cfg);

const checks = [];
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// healthy poll resets failures, follows server timeoutMs (clamped), emits msgs
{
  const p = step({ cont: null, failures: 2 }, {
    ok: true,
    env: { messages: [{ id: "a" }], continuation: "c1", timeoutMs: 5000, ended: false },
  });
  assert("healthy: state advances + resets failures", eq(p.state, { cont: "c1", failures: 0 }));
  assert("healthy: healthy flag + clamped wait", p.healthy === true && p.wait === 5000);
  assert("healthy: emits messages, no stop", p.emit.length === 1 && !p.stop);
}

// server timeoutMs below floor is clamped up
{
  const p = step({ cont: "c", failures: 0 }, { ok: true, env: { messages: [], continuation: "c2", timeoutMs: 10 } });
  assert("healthy: timeout clamped to minInterval", p.wait === cfg.minIntervalMs);
}

// ended (or null continuation) stops, still emits the final batch
{
  const a = step({ cont: "c", failures: 0 }, { ok: true, env: { messages: [{ id: "x" }], ended: true } });
  const b = step({ cont: "c", failures: 0 }, { ok: true, env: { messages: [], continuation: null } });
  assert("ended: stop=ended + emit", a.stop === "ended" && a.emit.length === 1);
  assert("null continuation: stop=ended", b.stop === "ended");
}

// failures back off exponentially and keep the continuation until reResolveAfter
{
  const f1 = step({ cont: "c", failures: 0 }, { ok: false, error: new Error("e") });
  const f2 = step(f1.state, { ok: false, error: new Error("e") });
  const f3 = step(f2.state, { ok: false, error: new Error("e") });
  assert("fail1: wait=base, keep cont", f1.wait === 1000 && f1.state.cont === "c" && f1.healthy === false);
  assert("fail2: wait=base*factor", f2.wait === 2000 && f2.state.cont === "c");
  assert("fail3: reResolveAfter -> drop cont, wait grows", f3.wait === 4000 && f3.state.cont === null);
  assert("failures: surfaces error", f1.error?.message === "e");
}

// max consecutive failures stops with reason=failed
{
  let s = { cont: "c", failures: 4 }; // next failure is the 5th == max
  const p = step(s, { ok: false, error: new Error("dead") });
  assert("maxFailures: stop=failed", p.stop === "failed" && p.state.failures === 5);
}

let allOk = true;
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`);
  if (!c.ok) allOk = false;
}
console.log(allOk ? "\nRESULT: ✅ pure step machine verified" : "\nRESULT: ❌ FAILURES above");
process.exit(allOk ? 0 : 1);
