// Focused regression tests for web URL security: relay allowlisting and
// relay-provided emoji URL sanitization before image/canvas sinks.

import {
  RELAY_DEFAULT,
  sanitizeChatMessage,
  sanitizeEmojiUrl,
  sanitizeMessageParts,
  sanitizeRelayBase,
} from "../url-security.ts"

const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

const APP = "https://app.example/index.html"
const trusted = { baseUrl: APP, trustedRelayOrigins: ["https://relay.example"] }

// relay base validation
assert("relay: empty uses default", sanitizeRelayBase("", { baseUrl: APP }) === RELAY_DEFAULT)
assert(
  "relay: arbitrary origin rejected",
  sanitizeRelayBase("https://evil.example/relay", { baseUrl: APP }) === RELAY_DEFAULT,
)
assert(
  "relay: same-origin relative allowed",
  sanitizeRelayBase("/relay", { baseUrl: APP }) === "https://app.example/relay",
)
assert(
  "relay: default origin allowed",
  sanitizeRelayBase(`${RELAY_DEFAULT}?x=1#frag`, { baseUrl: APP }) === RELAY_DEFAULT,
)
assert(
  "relay: explicit trusted https origin allowed",
  sanitizeRelayBase("https://relay.example/custom/", trusted) === "https://relay.example/custom",
)
assert(
  "relay: http cross-origin rejected even if listed",
  sanitizeRelayBase("http://relay.example/custom", {
    baseUrl: APP,
    trustedRelayOrigins: ["http://relay.example"],
  }) === RELAY_DEFAULT,
)
assert(
  "relay: credentials rejected",
  sanitizeRelayBase("https://user@relay.example/custom", trusted) === RELAY_DEFAULT,
)

// emoji URL validation
const pngData =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
assert("emoji: data png allowed", sanitizeEmojiUrl(pngData) === pngData)
assert(
  "emoji: yt3.ggpht.com allowed",
  sanitizeEmojiUrl("https://yt3.ggpht.com/emoji=w24-h24") === "https://yt3.ggpht.com/emoji=w24-h24",
)
assert(
  "emoji: googleusercontent subdomain allowed",
  sanitizeEmojiUrl("https://yt3.googleusercontent.com/emoji=s24") ===
    "https://yt3.googleusercontent.com/emoji=s24",
)
assert("emoji: http rejected", sanitizeEmojiUrl("http://yt3.ggpht.com/emoji") === "")
assert(
  "emoji: arbitrary https host rejected",
  sanitizeEmojiUrl("https://evil.example/emoji.png") === "",
)
assert(
  "emoji: deceptive suffix rejected",
  sanitizeEmojiUrl("https://yt3.ggpht.com.evil.example/emoji.png") === "",
)
assert(
  "emoji: bare googleusercontent rejected",
  sanitizeEmojiUrl("https://googleusercontent.com/emoji.png") === "",
)
assert("emoji: svg data rejected", sanitizeEmojiUrl("data:image/svg+xml;base64,PHN2Zy8+") === "")

// message-boundary sanitization preserves text and safe emoji while dropping unsafe URLs.
{
  const parts = sanitizeMessageParts([
    { t: "hello " },
    { u: "https://yt3.ggpht.com/good=s24", a: ":good:" },
    { u: "https://evil.example/bad.png", a: ":bad:" },
  ])
  assert(
    "parts: unsafe emoji becomes text fallback",
    JSON.stringify(parts) ===
      JSON.stringify([
        { t: "hello " },
        { u: "https://yt3.ggpht.com/good=s24", a: ":good:" },
        { t: ":bad:" },
      ]),
    JSON.stringify(parts),
  )
}

{
  const msg = sanitizeChatMessage({
    id: "1",
    ts: 0,
    kind: "text",
    author: "@a",
    authorType: "normal",
    authorColor: null,
    text: "hello",
    amount: null,
    paidColor: "RGB(21, 101, 192)",
    parts: [{ u: "javascript:alert(1)", a: ":x:" }],
  })
  assert("message: unsafe part sanitized", msg.parts.length === 1 && msg.parts[0].t === ":x:")
  assert("message: invalid paid color dropped", msg.paidColor === null)
}

{
  const msg = sanitizeChatMessage({
    id: "2",
    ts: 0,
    kind: "paid",
    author: "@b",
    authorType: "normal",
    authorColor: null,
    text: "hello",
    amount: "$5.00",
    paidColor: "#1565C0",
    parts: [{ t: "hello" }],
  })
  assert("message: paid color normalized", msg.paidColor === "#1565c0")
}

// Classic emoji.js creates Image instances; it must refuse unsafe URLs before src assignment.
{
  const assigned = []
  class FakeImage {
    complete = true
    naturalWidth = 1
    set src(value) {
      assigned.push(value)
      this._src = value
    }
    get src() {
      return this._src
    }
  }
  globalThis.Image = FakeImage
  await import("../emoji.js")
  assert(
    "emoji.js: unsafe get returns null",
    globalThis.SYCEmoji.get("https://evil.example/x.png") === null,
  )
  assert("emoji.js: unsafe get did not assign src", assigned.length === 0, assigned.join(","))
  const img = globalThis.SYCEmoji.get("https://yt3.ggpht.com/good=s24")
  assert("emoji.js: safe get assigns src", img && assigned[0] === "https://yt3.ggpht.com/good=s24")
  const first = globalThis.SYCEmoji.get("https://yt3.ggpht.com/emoji0=s24")
  for (let i = 1; i <= 500; i++) {
    globalThis.SYCEmoji.get(`https://yt3.ggpht.com/emoji${i}=s24`)
  }
  const reloaded = globalThis.SYCEmoji.get("https://yt3.ggpht.com/emoji0=s24")
  assert("emoji.js: cache evicts least-recently-used image", reloaded !== first)
}

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk ? `\nRESULT: ✅ URL security verified (${checks.length} checks)` : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
