import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const extensionDir = resolve(root, "extension")
const failures = []
const warnings = []

function fail(message) {
  failures.push(message)
}

function warn(message) {
  warnings.push(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function rel(path) {
  return relative(root, path).replaceAll("\\", "/")
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length
}

function checkManifest() {
  const manifestPath = resolve(extensionDir, "manifest.json")
  const manifest = readJson(manifestPath)
  if (manifest.manifest_version !== 3) fail("extension/manifest.json must stay on Manifest V3.")
  if (!sameArray(manifest.permissions, ["storage"])) {
    fail('extension/manifest.json permissions must remain minimal: ["storage"].')
  }
  if ("host_permissions" in manifest) {
    fail(
      "extension/manifest.json must not request host_permissions; content_scripts.matches scopes injection.",
    )
  }

  const csp = manifest.content_security_policy?.extension_pages ?? ""
  if (!csp.includes("script-src 'self'")) fail("extension_pages CSP must use script-src 'self'.")
  if (!csp.includes("object-src 'self'")) fail("extension_pages CSP must use object-src 'self'.")
  for (const forbidden of [
    "'unsafe-inline'",
    "'unsafe-eval'",
    "http:",
    "https:",
    "data:",
    "blob:",
  ]) {
    if (csp.includes(forbidden)) fail(`extension_pages CSP must not contain ${forbidden}.`)
  }

  const contentScripts = manifest.content_scripts ?? []
  const rendererScript = contentScripts.find(script =>
    sameArray(script.matches, ["https://www.youtube.com/watch*", "https://www.youtube.com/live/*"]),
  )
  const extractorScript = contentScripts.find(script =>
    sameArray(script.matches, ["https://www.youtube.com/live_chat*"]),
  )
  if (!rendererScript) {
    fail("renderer content_script must remain scoped to youtube watch/live top-frame pages.")
  } else {
    if (rendererScript.all_frames !== false)
      fail("renderer content_script all_frames must be false.")
    if (
      !sameArray(rendererScript.js, [
        "sanitize.js",
        "scoring.js",
        "danmaku.js",
        "settings.js",
        "content.js",
      ])
    ) {
      fail("renderer content_script JS list changed unexpectedly.")
    }
  }
  if (!extractorScript) {
    fail("extractor content_script must remain scoped to youtube live_chat frames.")
  } else {
    if (extractorScript.all_frames !== true)
      fail("extractor content_script all_frames must be true.")
    if (!sameArray(extractorScript.js, ["sanitize.js", "scoring.js", "filter.js", "content.js"])) {
      fail("extractor content_script JS list changed unexpectedly.")
    }
  }

  // The extension must not expose any web-accessible resources.
  const webResources = manifest.web_accessible_resources ?? []
  if (webResources.length !== 0) {
    fail("web_accessible_resources must be empty (nothing is exposed to pages).")
  }
}

function checkExtensionSource() {
  const files = walk(extensionDir).filter(
    path =>
      [".js", ".mjs", ".html", ".json"].includes(extname(path)) &&
      !rel(path).startsWith("extension/test/"),
  )
  const forbidden = [
    { re: /\beval\s*\(/g, label: "eval()" },
    { re: /\bnew\s+Function\b/g, label: "new Function" },
    { re: /\bFunction\s*\(/g, label: "Function constructor" },
    { re: /\.innerHTML\b/g, label: "innerHTML" },
    { re: /\.outerHTML\b/g, label: "outerHTML" },
    { re: /\.insertAdjacentHTML\s*\(/g, label: "insertAdjacentHTML()" },
    { re: /\bdocument\.write\s*\(/g, label: "document.write()" },
    { re: /\bimportScripts\s*\(/g, label: "importScripts()" },
    { re: /<script[^>]+src=["']https?:\/\//gi, label: "remote script tag" },
    { re: /<link[^>]+href=["']https?:\/\//gi, label: "remote stylesheet tag" },
  ]

  for (const file of files) {
    const text = readFileSync(file, "utf8")
    for (const rule of forbidden) {
      for (const match of text.matchAll(rule.re)) {
        fail(`${rel(file)}:${lineNumber(text, match.index ?? 0)} uses ${rule.label}.`)
      }
    }

    // Allow the SVG XML namespace constant (used by createElementNS, never fetched).
    const remoteUrl =
      /https?:\/\/(?!(?:www\.youtube\.com\/(?:watch\*|live\/\*|live_chat\*)|www\.w3\.org\/2000\/svg))/g
    for (const match of text.matchAll(remoteUrl)) {
      fail(`${rel(file)}:${lineNumber(text, match.index ?? 0)} contains a remote URL.`)
    }

    // No fetch() is allowed anywhere in the extension.
    for (const match of text.matchAll(/\bfetch\s*\(/g)) {
      fail(`${rel(file)}:${lineNumber(text, match.index ?? 0)} uses fetch() (not allowed).`)
    }
  }
}

function checkPackagePolicy() {
  for (const relDir of [".", "web", "worker"]) checkPackageRoot(relDir)
}

const allowedInstallScripts = new Set([
  "node_modules/esbuild",
  "node_modules/sharp",
  "node_modules/workerd",
])

function checkPackageRoot(relDir) {
  const label = relDir === "." ? "." : relDir
  const packagePath = resolve(root, relDir, "package.json")
  const lockPath = resolve(root, relDir, "package-lock.json")

  if (!existsSync(packagePath)) fail(`${label}/package.json is missing.`)
  if (!existsSync(lockPath)) {
    fail(`${label}/package-lock.json is missing; every package root must have a lockfile.`)
    return
  }

  const pkg = readJson(packagePath)
  const lock = readJson(lockPath)
  if (pkg.private !== true) {
    fail(`${label}/package.json must remain private to prevent accidental npm publish.`)
  }
  if (lock.lockfileVersion !== 3) fail(`${label}/package-lock.json must use lockfileVersion 3.`)

  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (/^[~^*]|x|\|\||[<>]/.test(spec)) {
        fail(`${label}/package.json ${section}.${name} must be pinned exactly, found ${spec}.`)
      }
    }
  }

  const rootLock = lock.packages?.[""] ?? {}
  if (rootLock.name !== pkg.name) {
    fail(`${label}/package-lock.json root package name does not match package.json.`)
  }
  if ((pkg.version ?? rootLock.version) !== rootLock.version) {
    fail(`${label}/package-lock.json root package version does not match package.json.`)
  }

  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(rootLock[section] ?? {})) {
      if (pkg[section]?.[name] !== spec) {
        fail(
          `${label}/package-lock.json root ${section}.${name} (${spec}) does not match package.json.`,
        )
      }
    }
  }

  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path || !path.startsWith("node_modules/")) continue
    if (!meta.integrity) fail(`${label}/package-lock.json entry ${path} is missing integrity.`)
    if (!meta.resolved?.startsWith("https://registry.npmjs.org/")) {
      fail(`${label}/package-lock.json entry ${path} must resolve from the npm registry.`)
    }
    if (meta.hasInstallScript && !meta.optional && !allowedInstallScripts.has(path)) {
      fail(`${label}/package-lock.json entry ${path} has a lifecycle install script.`)
    } else if (meta.hasInstallScript) {
      warn(
        `${label}/package-lock.json entry ${path} has an install script; keep it dev-only or optional.`,
      )
    }
  }
}

checkManifest()
checkExtensionSource()
checkPackagePolicy()

for (const message of warnings) console.warn(`WARN ${message}`)

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL ${message}`)
  process.exit(1)
}

console.log("security policy check ok")
