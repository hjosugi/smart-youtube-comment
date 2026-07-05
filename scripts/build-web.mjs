// Build the web/ PWA into web/dist/:
//   1. bundle the TS module graph (entry app.ts) into one app.js
//   2. copy script globals, their shared ESM helpers, and static assets verbatim
// Script globals (scoring/danmaku/settings/filter/store/emoji) expose globalThis.SYC*
// and are not bundled into app.js.

import { execFileSync } from "node:child_process"
import { rmSync, mkdirSync, cpSync } from "node:fs"
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

console.log("built -> web/dist")
