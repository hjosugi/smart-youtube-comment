// Background service-worker tests. Loads background.js in a VM and exercises
// sender validation plus render payload sanitization at the extension boundary.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

const loadHelpers = () => {
  const syncData = new Map()
  const sync = {
    async get(key) {
      return { [key]: syncData.get(key) }
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) syncData.set(key, value)
    },
  }
  const sandbox = {
    globalThis: null,
    URL,
    chrome: {
      action: { onClicked: { addListener() {} } },
      commands: { onCommand: { addListener(listener) { sandbox.commandListener = listener } } },
      runtime: {
        lastError: null,
        openOptionsPage() {},
        onMessage: { addListener(listener) { sandbox.listener = listener } },
      },
      storage: {
        sync,
        local: sync,
        onChanged: { addListener() {} },
      },
      tabs: { sendMessage() {} },
    },
  }
  sandbox.globalThis = sandbox
  sandbox.globalThis.__SYC_TEST__ = true

  for (const file of ["sanitize.js", "settings.js", "background.js"]) {
    runInNewContext(readFileSync(resolve("extension", file), "utf8"), sandbox, {
      filename: `extension/${file}`,
    })
  }
  return { helpers: sandbox.globalThis.__SYCBackgroundTest, sandbox, syncData }
}

const { helpers, sandbox, syncData } = loadHelpers()

assert.equal(helpers.isAllowedSender({ tab: { id: 1 }, url: "https://www.youtube.com/live_chat" }), true)
assert.equal(helpers.isAllowedSender({ tab: { id: 1 }, url: "https://music.youtube.com/watch?v=x" }), false)
assert.equal(helpers.isAllowedSender({ tab: {}, url: "https://www.youtube.com/watch?v=x" }), false)
assert.equal(helpers.isAllowedSender({ tab: { id: 1 }, url: "not a url" }), false)

const payload = helpers.sanitizeRenderPayload({
  text: `  ${"x".repeat(620)}  `,
  author: "  Alice\nModerator  ",
  kind: "bad-kind",
  authorType: "bad-role",
  amount: ` ${"9".repeat(80)} `,
  paidColor: "rgb(21, 101, 192)",
  tier: 99,
  durationMs: -1,
  score: 2,
  emphasis: -1,
})

assert.equal(payload.text.length, 500)
assert.equal(payload.author, "Alice Moderator")
assert.equal(payload.kind, "text")
assert.equal(payload.authorType, "normal")
assert.equal(payload.amount.length, 40)
assert.equal(payload.paidColor, "#1565c0")
assert.equal(payload.tier, 2)
assert.equal(payload.durationMs, 1000)
assert.equal(payload.score, 1)
assert.equal(payload.emphasis, 0)
assert.equal("reasons" in payload, false)
assert.equal("createdAt" in payload, false)
assert.equal(helpers.sanitizeRenderPayload({ text: "   " }), null)
assert.equal(typeof sandbox.listener, "function")
assert.equal(typeof sandbox.commandListener, "function")

await helpers.toggleOverlaySetting()
assert.equal(syncData.get("syc:settings").enabled, false)
await sandbox.commandListener("toggle-overlay")
await new Promise(done => setTimeout(done, 0))
assert.equal(syncData.get("syc:settings").enabled, true)

console.log("background ok (22 assertions)")
