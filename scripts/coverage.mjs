import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { relative, resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const coverageDir = resolve(root, ".coverage")

rmSync(coverageDir, { recursive: true, force: true })
execFileSync("node", ["scripts/test.mjs"], {
  cwd: root,
  env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
  stdio: "inherit",
})

if (!existsSync(coverageDir)) throw new Error("No V8 coverage output was written.")

let files = 0
let totalBytes = 0
let coveredBytes = 0

for (const entry of readdirSync(coverageDir)) {
  if (!entry.endsWith(".json")) continue
  const data = JSON.parse(readFileSync(resolve(coverageDir, entry), "utf8"))
  for (const script of data.result ?? []) {
    if (!script.url?.startsWith("file://")) continue
    const path = fileURLToPath(script.url)
    const rel = relative(root, path).replaceAll("\\", "/")
    if (
      rel.startsWith("node_modules/") ||
      rel.includes("/node_modules/") ||
      rel.startsWith("web/dist/") ||
      rel.startsWith(".coverage/")
    ) {
      continue
    }
    if (!/^(extension|web|worker|scripts|bench|sandbox)\//.test(rel)) continue
    const text = readFileSync(path, "utf8")
    const covered = new Array(text.length).fill(false)
    for (const fn of script.functions ?? []) {
      for (const range of fn.ranges ?? []) {
        if (range.count <= 0) continue
        for (let i = range.startOffset; i < Math.min(range.endOffset, covered.length); i++)
          covered[i] = true
      }
    }
    files++
    totalBytes += covered.length
    coveredBytes += covered.filter(Boolean).length
  }
}

const percent = totalBytes ? (coveredBytes / totalBytes) * 100 : 0
console.log(
  `coverage: ${files} files, ${coveredBytes}/${totalBytes} bytes (${percent.toFixed(1)}%)`,
)
if (files === 0 || totalBytes === 0) process.exit(1)
