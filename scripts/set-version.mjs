import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const version = process.argv[2]

if (!version || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <version>")
  console.error("Example: node scripts/set-version.mjs 0.1.1")
  process.exit(1)
}

const root = resolve(new URL("..", import.meta.url).pathname)
const targets = [resolve(root, "package.json"), resolve(root, "extension/manifest.json")]

for (const target of targets) {
  const json = JSON.parse(readFileSync(target, "utf8"))
  json.version = version
  writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`)
}

console.log(`Version set to ${version} in package.json and extension/manifest.json`)
