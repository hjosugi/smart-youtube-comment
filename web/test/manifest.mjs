// Pure test: the web app manifest is valid and the service-worker shell list
// only references files that actually exist. No browser needed.

import { readFile, access } from "node:fs/promises"

// Verify the BUILT app (web/dist) — run `node scripts/build-web.mjs` first.
const WEB = new URL("../../web/dist/", import.meta.url).pathname
const checks = []
const assert = (name, cond, extra = "") => checks.push({ name, ok: !!cond, extra })

const manifest = JSON.parse(
  await readFile(new URL("../../web/dist/manifest.webmanifest", import.meta.url), "utf8"),
)
assert("name set", manifest.name === "Smart YouTube Comment")
assert("start_url set", manifest.start_url === "./")
assert("display standalone", manifest.display === "standalone")
assert(
  "share_target maps shared URL into launch param",
  manifest.share_target?.method === "GET" && manifest.share_target?.params?.url === "v",
)
assert("theme/background colors", !!manifest.theme_color && !!manifest.background_color)
assert("has >=1 icon", Array.isArray(manifest.icons) && manifest.icons.length >= 1)
assert(
  "a maskable icon exists",
  manifest.icons.some(i => /maskable/.test(i.purpose || "")),
)

// every manifest icon src resolves to a real file
for (const icon of manifest.icons) {
  let exists = true
  try {
    await access(new URL(icon.src, `file://${WEB}`))
  } catch {
    exists = false
  }
  assert(`icon exists: ${icon.src}`, exists)
}

// the service worker shell only lists files that exist (no broken precache)
const swSrc = await readFile(new URL("../../web/dist/sw.js", import.meta.url), "utf8")
assert(
  "SW cache name is build-stamped",
  /const CACHE = "syc-shell-[0-9a-f]{16}"/.test(swSrc) && !swSrc.includes("__SYC_SHELL_VERSION__"),
)
const shell =
  (swSrc.match(/const SHELL = \[([\s\S]*?)\]/)?.[1] || "")
    .match(/"\.\/[^"]*"/g)
    ?.map(s => s.slice(3, -1))
    .filter(p => p && !p.endsWith("/")) ?? []
assert("SHELL parsed", shell.length > 5, `parsed ${shell.length}`)
for (const rel of shell) {
  let exists = true
  try {
    await access(new URL(`../../web/dist/${rel}`, import.meta.url))
  } catch {
    exists = false
  }
  assert(`shell file exists: ${rel}`, exists)
}

let allOk = true
for (const c of checks) {
  console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : "  -> " + c.extra}`)
  if (!c.ok) allOk = false
}
console.log(
  allOk
    ? `\nRESULT: ✅ manifest + SW shell verified (${checks.length} checks)`
    : "\nRESULT: ❌ FAILURES",
)
process.exit(allOk ? 0 : 1)
