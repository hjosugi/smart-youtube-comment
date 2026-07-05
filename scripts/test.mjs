// Local test runner — typecheck, build, then run every suite. Usage: node scripts/test.mjs
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const REQUIRE_E2E = process.env.SYC_REQUIRE_E2E === "1"

// Type-check and build the web app (the e2e + manifest suites run against web/dist).
console.log("── security policy + typecheck + build ──")
execFileSync("node", [join(ROOT, "scripts/security-check.mjs")], { cwd: ROOT, stdio: "inherit" })
execFileSync("npm", ["run", "typecheck"], { cwd: ROOT, stdio: "inherit" })
execFileSync("node", [join(ROOT, "scripts/build-web.mjs")], { cwd: ROOT, stdio: "inherit" })

// The e2e group drives a real browser via Playwright. That's an optional dev/CI
// dependency (npm i -D playwright + npx playwright install chromium). When it's
// not installed we SKIP the e2e suites instead of reporting spurious failures.
let e2eSkip = ""
try {
  const { chromium } = await import("playwright")
  const exe = chromium.executablePath()
  if (!exe || !existsSync(exe)) {
    e2eSkip = "chromium not installed (run: npx playwright install chromium)"
  }
} catch {
  e2eSkip = "playwright not installed (run: npm i -D playwright && npx playwright install chromium)"
}

if (e2eSkip && REQUIRE_E2E) {
  console.error(`E2E browser is required but unavailable: ${e2eSkip}`)
  process.exit(1)
}

const SUITES = [
  ["unit", "worker/test/innertube-parse.mjs"],
  ["unit", "worker/test/innertube-io.mjs"],
  ["unit", "extension/test/content-extract.mjs"],
  ["unit", "web/test/playback.mjs"],
  ["unit", "web/test/config.mjs"],
  ["unit", "web/test/url-security.mjs"],
  ["unit", "web/test/player.mjs"],
  ["unit", "web/test/videoctl.mjs"],
  ["unit", "web/test/i18n.mjs"],
  ["unit", "web/test/pipeline.mjs"],
  ["unit", "web/test/chat-client-pure.mjs"],
  ["unit", "web/test/store-settings.mjs"],
  ["unit", "web/test/manifest.mjs"],
  ["unit", "web/test/lifecycle.mjs"],
  ["deterministic", "web/test/chat-client-adaptive.mjs"],
  ["deterministic", "web/test/chat-client-behavior.mjs"],
  ["e2e", "web/test/e2e.mjs"],
  ["e2e", "web/test/pwa.mjs"],
  ["e2e", "web/test/settings-e2e.mjs"],
  ["e2e", "web/test/views-e2e.mjs"],
  ["e2e", "web/test/videoctl-e2e.mjs"],
]

let pass = 0
let fail = 0
let skip = 0
let group = ""
for (const [g, suite] of SUITES) {
  if (g !== group) {
    group = g
    console.log(`\n──── ${g.toUpperCase()} ────`)
  }
  const name = suite.replace(/^.*\//, "")
  if (g === "e2e" && e2eSkip) {
    console.log(`⏭  ${name}  (skipped: ${e2eSkip})`)
    skip++
    continue
  }
  try {
    const out = execFileSync("node", [join(ROOT, suite)], { encoding: "utf8" })
    const tail = out.match(/\((\d+) (?:assertions|checks)\)/)
    console.log(`✅ ${name}${tail ? "  " + tail[0] : ""}`)
    pass++
  } catch (e) {
    console.log(`❌ ${name}`)
    console.log((e.stdout || e.message || "").toString().split("\n").slice(-8).join("\n"))
    fail++
  }
}

console.log(`\n════ ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""} ════`)
if (fail === 0) {
  console.log("\n── sandbox smoke ──")
  execFileSync("node", [join(ROOT, "scripts/check-sandbox.mjs")], { cwd: ROOT, stdio: "inherit" })
}
process.exit(fail ? 1 : 0)
