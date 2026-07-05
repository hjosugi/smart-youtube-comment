import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const version = process.argv[2]

if (!version || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <version>")
  console.error("Example: node scripts/set-version.mjs 0.1.1")
  process.exit(1)
}

const root = resolve(new URL("..", import.meta.url).pathname)
const targets = [
  resolve(root, "package.json"),
  resolve(root, "package-lock.json"),
  resolve(root, "extension/manifest.json"),
  resolve(root, "web/package.json"),
  resolve(root, "web/package-lock.json"),
  resolve(root, "worker/package.json"),
  resolve(root, "worker/package-lock.json"),
]

for (const target of targets) {
  if (!existsSync(target)) continue
  const json = JSON.parse(readFileSync(target, "utf8"))
  if (target.endsWith("package-lock.json")) {
    json.version = version
    if (json.packages?.[""]) json.packages[""].version = version
  } else {
    json.version = version
  }
  writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`)
}

console.log(`Version set to ${version} in package roots and extension/manifest.json`)
