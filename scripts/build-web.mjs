// Build the web/ PWA into web/dist/:
//   1. bundle the TS module graph (entry app.ts) into one app.js
//   2. copy script globals, their shared ESM helpers, and static assets verbatim
// Script globals (scoring/danmaku/settings/filter/store/emoji) expose globalThis.SYC*
// and are not bundled into app.js.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const WEB = new URL("../web/", import.meta.url).pathname
const DIST = join(WEB, "dist")
const ESBUILD = new URL("../node_modules/.bin/esbuild", import.meta.url).pathname

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

execFileSync(
  ESBUILD,
  [
    join(WEB, "app.ts"),
    "--bundle",
    "--format=esm",
    "--target=es2022",
    "--charset=utf8",
    `--outfile=${join(DIST, "app.js")}`,
  ],
  { stdio: "inherit" },
)

const SCRIPTS = [
  "math.js",
  "theme.js",
  "scoring.js",
  "danmaku.js",
  "settings.js",
  "filter.js",
  "store.js",
  "emoji.js",
  "sw.js",
]
const STATIC = ["index.html", "styles.css", "manifest.webmanifest"]
for (const f of [...SCRIPTS, ...STATIC]) cpSync(join(WEB, f), join(DIST, f))
cpSync(join(WEB, "icons"), join(DIST, "icons"), { recursive: true })

const stampServiceWorker = () => {
  const swPath = join(DIST, "sw.js")
  const sw = readFileSync(swPath, "utf8")
  const shellEntries =
    (sw.match(/const SHELL = \[([\s\S]*?)\]/)?.[1] || "")
      .match(/"\.\/[^"]*"/g)
      ?.map(s => s.slice(1, -1)) ?? []
  if (!shellEntries.length) throw new Error("Could not parse service worker SHELL list")
  if (!sw.includes("__SYC_SHELL_VERSION__")) {
    throw new Error("Service worker cache version placeholder is missing")
  }

  const files = new Set(
    shellEntries.map(entry => (entry === "./" ? "index.html" : entry.replace(/^\.\//, ""))),
  )
  const hash = createHash("sha256")
  for (const rel of [...files].sort()) {
    hash.update(rel)
    hash.update("\0")
    hash.update(readFileSync(join(DIST, rel)))
    hash.update("\0")
  }
  const version = hash.digest("hex").slice(0, 16)
  writeFileSync(swPath, sw.replace("__SYC_SHELL_VERSION__", version))
}

stampServiceWorker()

console.log("built -> web/dist")
