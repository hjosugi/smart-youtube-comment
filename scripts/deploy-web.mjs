import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const wrangler = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname
const dryRun = process.argv.includes("--dry-run")
const allowDirty = process.env.SYC_ALLOW_DIRTY_DEPLOY === "1"
const project =
  process.env.CF_PAGES_PROJECT_NAME || process.env.CLOUDFLARE_PAGES_PROJECT || "syc-danmaku"

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return fallback
  }
}

function currentBranch() {
  return (
    process.env.CF_PAGES_BRANCH ||
    process.env.GITHUB_REF_NAME ||
    git(["branch", "--show-current"], "main") ||
    "main"
  )
}

if (!existsSync(wrangler)) {
  throw new Error("wrangler is not installed. Run npm ci before deploy:web.")
}

console.log("building web/dist")
execFileSync("node", [join(root, "scripts/build-web.mjs")], { cwd: root, stdio: "inherit" })

const dirty = git(["status", "--porcelain"])
if (dirty && !allowDirty) {
  console.error(
    "Refusing to deploy from a dirty worktree. Commit generated files or set SYC_ALLOW_DIRTY_DEPLOY=1.",
  )
  console.error(dirty)
  process.exit(1)
}

const args = ["pages", "deploy", "web/dist", "--project-name", project, "--branch", currentBranch()]
if (allowDirty) args.push("--commit-dirty=true")

console.log(`wrangler ${args.join(" ")}`)
if (!dryRun) execFileSync(wrangler, args, { cwd: root, stdio: "inherit" })
