// Background service-worker tests. Loads background.js in a VM and exercises
// sender validation plus render payload sanitization at the extension boundary.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

const loadHelpers = () => {
  const sandbox = {
    globalThis: null,
    URL,
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        lastError: null,
        openOptionsPage() {},
        onMessage: { addListener(listener) { sandbox.listener = listener } },
      },
      tabs: { sendMessage() {} },
    },
  }
  sandbox.globalThis = sandbox
  sandbox.globalThis.__SYC_TEST__ = true

  runInNewContext(readFileSync(resolve("extension/background.js"), "utf8"), sandbox, {
    filename: "extension/background.js",
  })
  return { helpers: sandbox.globalThis.__SYCBackgroundTest, sandbox }
}

const { helpers, sandbox } = loadHelpers()

assert.equal(helpers.isAllowedSender({ tab: { id: 1 }, url: "https://www.youtube.com/live_chat" }), true)
assert.equal(helpers.isAllowedSender({ tab: { id: 1 }, url: "https://music.youtube.com/watch?v=x" }), false)
assert.equal(helpers.isAllowedSender({ tab: {}, url: "https://www.youtube.com/watch?v=x" }), false)
assert.equal(helpers.isAllowedSender({ tab: { id: 1 }, url: "not a url" }), false)

const payload = helpers.sanitizeRenderPayload({
  text: `  ${"x".repeat(620)}  `,
  author: "  Alice\nModerator  ",
  kind: "bad-kind",
  authorType: "bad-role",
  tier: 99,
  durationMs: -1,
  score: 2,
  emphasis: -1,
  reasons: ["ok", 123, "fine"],
  createdAt: Date.now() + 120_000,
})

assert.equal(payload.text.length, 500)
assert.equal(payload.author, "Alice Moderator")
assert.equal(payload.kind, "text")
assert.equal(payload.authorType, "normal")
assert.equal(payload.tier, 2)
assert.equal(payload.durationMs, 1000)
assert.equal(payload.score, 1)
assert.equal(payload.emphasis, 0)
assert.deepEqual(payload.reasons, ["ok", "fine"])
assert.ok(payload.createdAt <= Date.now() + 60_000)
assert.equal(helpers.sanitizeRenderPayload({ text: "   " }), null)
assert.equal(typeof sandbox.listener, "function")

console.log("background ok (17 assertions)")
