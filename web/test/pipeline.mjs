// Pure test of the message->payload pipeline (no DOM, no danmaku canvas).
// scoring.js is a browser-free IIFE, safe to import in node; we stub the overlay.

import { makeRenderer, renderBatch } from "../pipeline.ts"
import "../scoring.js" // sets globalThis.SYCScoring

const { createFallbackScorer, buildRenderPlan } = globalThis.SYCScoring
const render = makeRenderer(createFallbackScorer(), buildRenderPlan)

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

// a substantive message -> a complete push payload
{
  const p = render({
    text: "that play was genuinely incredible, replay it",
    author: "@a",
    authorType: "member",
    kind: "text",
  })
  assert("payload has text+authorType", p && p.text && p.authorType === "member")
  assert("payload has render plan fields", p && Number.isInteger(p.tier) && p.durationMs > 0)
  assert(
    "payload carries no internal score leak beyond contract",
    p && "score" in p && "emphasis" in p && !("reasons" in p),
  )
}

// renderBatch admits via the overlay and counts only accepted pushes
{
  let pushed = 0
  const fakeOverlay = { push: x => (x && x.text ? (pushed++, true) : false) }
  const msgs = [
    { text: "hello everyone good to be here", author: "@a", authorType: "normal", kind: "text" },
    { text: "nice", author: "@b", authorType: "normal", kind: "text" },
    { text: "welcome to the stream", author: "@c", authorType: "owner", kind: "text" },
  ]
  const shown = renderBatch(render, fakeOverlay, msgs)
  assert(
    "renderBatch returns admitted count",
    shown === pushed && shown >= 1,
    `shown=${shown} pushed=${pushed}`,
  )
}

// dropped messages (buildRenderPlan -> null) are not pushed
{
  let pushed = 0
  const overlay = { push: () => (pushed++, true) }
  // empty text -> scorer show may still be true, but pipeline returns payload only if plan exists;
  // an empty-text message should never produce a renderable payload
  renderBatch(render, overlay, [{ text: "", author: "@x", authorType: "normal", kind: "text" }])
  assert("empty text not rendered", pushed === 0, `pushed=${pushed}`)
}

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(allOk ? "\nRESULT: ✅ pipeline verified" : "\nRESULT: ❌ FAILURES")
process.exit(allOk ? 0 : 1)
