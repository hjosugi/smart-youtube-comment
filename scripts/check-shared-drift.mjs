import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

const root = resolve(new URL("..", import.meta.url).pathname)
const strictPairs = [
  ["extension/scoring.js", "web/scoring.js"],
  ["extension/filter.js", "web/filter.js"],
]

function read(rel) {
  return readFileSync(resolve(root, rel), "utf8")
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12)
}

function lineCount(text) {
  return text.split("\n").length
}

let failed = false

for (const [left, right] of strictPairs) {
  const a = read(left)
  const b = read(right)
  if (a !== b) {
    failed = true
    console.error(`FAIL ${left} and ${right} must stay byte-identical.`)
    try {
      console.error(execFileSync("diff", ["-u", left, right], { cwd: root, encoding: "utf8" }))
    } catch (error) {
      console.error(error.stdout || error.message)
    }
  }
}

const extensionDanmaku = read("extension/danmaku.js")
const webDanmaku = read("web/danmaku.js")
if (extensionDanmaku === webDanmaku) {
  console.log("shared drift check ok; danmaku.js copies are identical")
} else {
  console.log(
    [
      "shared drift check ok;",
      "danmaku.js intentionally differs",
      `extension=${lineCount(extensionDanmaku)} lines/${hash(extensionDanmaku)}`,
      `web=${lineCount(webDanmaku)} lines/${hash(webDanmaku)}`,
    ].join(" "),
  )
}

if (failed) process.exit(1)
