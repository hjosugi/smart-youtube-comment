#!/usr/bin/env node
import { readFileSync, statSync, existsSync } from "node:fs"
import { basename, resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const releaseDir = resolve(root, ".release")
const packagePath = resolve(root, "package.json")
const manifestPath = resolve(root, "extension/manifest.json")

const pkg = JSON.parse(readFileSync(packagePath, "utf8"))
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

const argv = process.argv.slice(2)
const commandArg = argv[0]
const command =
  !commandArg || commandArg === "help" || commandArg === "--help" || commandArg === "-h"
    ? "help"
    : commandArg
const args = argv.slice(1)

const apiBase = "https://chromewebstore.googleapis.com"
const tokenUrl = "https://oauth2.googleapis.com/token"

function usage() {
  console.log(`Usage: node scripts/chrome-webstore.mjs <command> [options]

Commands:
  status    Fetch Chrome Web Store item status.
  upload    Upload the packaged zip for the current manifest version.
  publish   Submit the already uploaded package for review/publishing.
  submit    Upload, wait for upload processing, then publish.

Options:
  --zip <path>                 Zip artifact to upload. Defaults to .release/${pkg.name}-v${manifest.version}.zip
  --publisher-id <id>          Overrides CHROME_WEBSTORE_PUBLISHER_ID.
  --extension-id <id>          Overrides CHROME_WEBSTORE_EXTENSION_ID.
  --publish-type <type>        DEFAULT_PUBLISH or STAGED_PUBLISH. Defaults to DEFAULT_PUBLISH.
  --deploy-percentage <0-100>  Optional initial rollout percentage.
  --skip-review                Ask the API to skip review when the item is eligible.
  --allow-warnings             Do not fail publish on API validation warnings.
  --dry-run                    Print the intended operation without network calls.

Required environment for network calls:
  CHROME_WEBSTORE_PUBLISHER_ID
  CHROME_WEBSTORE_EXTENSION_ID
  CHROME_WEBSTORE_CLIENT_ID
  CHROME_WEBSTORE_CLIENT_SECRET
  CHROME_WEBSTORE_REFRESH_TOKEN

Alternative auth:
  CHROME_WEBSTORE_ACCESS_TOKEN can replace the client/secret/refresh-token trio.
`)
}

function argValue(name) {
  const index = args.indexOf(name)
  if (index === -1) return ""
  if (index === args.length - 1) throw new Error(`${name} requires a value`)
  return args[index + 1]
}

function hasFlag(name) {
  return args.includes(name)
}

function configValue(argName, envName) {
  return argValue(argName) || process.env[envName] || ""
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function requireValue(name, value) {
  if (!value) throw new Error(`Missing required configuration: ${name}`)
  return value
}

function resolveZipPath() {
  const explicit = argValue("--zip") || process.env.CHROME_WEBSTORE_ZIP || ""
  const artifactPath = explicit
    ? resolve(root, explicit)
    : resolve(releaseDir, `${pkg.name}-v${manifest.version}.zip`)

  if (!existsSync(artifactPath)) {
    throw new Error(
      `Missing zip artifact: ${artifactPath}\nRun npm run release:zip first, or pass --zip <path>.`,
    )
  }
  const stat = statSync(artifactPath)
  if (!stat.isFile()) throw new Error(`Zip artifact is not a file: ${artifactPath}`)
  if (stat.size === 0) throw new Error(`Zip artifact is empty: ${artifactPath}`)
  if (!artifactPath.endsWith(".zip"))
    throw new Error(`Artifact must be a .zip file: ${artifactPath}`)
  return artifactPath
}

function storeIds(required) {
  const publisherId = configValue("--publisher-id", "CHROME_WEBSTORE_PUBLISHER_ID")
  const extensionId = configValue("--extension-id", "CHROME_WEBSTORE_EXTENSION_ID")
  if (!required) {
    return {
      publisherId: publisherId || "PUBLISHER_ID",
      extensionId: extensionId || "EXTENSION_ID",
    }
  }
  return {
    publisherId: requireValue("CHROME_WEBSTORE_PUBLISHER_ID", publisherId),
    extensionId: requireValue("CHROME_WEBSTORE_EXTENSION_ID", extensionId),
  }
}

function itemName({ publisherId, extensionId }) {
  return `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`
}

function endpoint(ids, suffix, upload = false) {
  const base = upload ? `${apiBase}/upload/v2` : `${apiBase}/v2`
  return `${base}/${itemName(ids)}:${suffix}`
}

function parseDeployPercentage() {
  const raw = argValue("--deploy-percentage") || process.env.CHROME_WEBSTORE_DEPLOY_PERCENTAGE || ""
  if (!raw) return null
  if (!/^\d+$/.test(raw)) throw new Error(`deploy percentage must be an integer, got: ${raw}`)
  const value = Number(raw)
  if (value < 0 || value > 100) throw new Error(`deploy percentage must be 0-100, got: ${raw}`)
  return value
}

function publishBody() {
  const publishType =
    argValue("--publish-type") || process.env.CHROME_WEBSTORE_PUBLISH_TYPE || "DEFAULT_PUBLISH"
  if (!["DEFAULT_PUBLISH", "STAGED_PUBLISH"].includes(publishType)) {
    throw new Error(`Unsupported publish type: ${publishType}`)
  }

  const skipReview =
    hasFlag("--skip-review") || parseBool(process.env.CHROME_WEBSTORE_SKIP_REVIEW, false)
  const blockOnWarnings =
    !hasFlag("--allow-warnings") && parseBool(process.env.CHROME_WEBSTORE_BLOCK_ON_WARNINGS, true)
  const deployPercentage = parseDeployPercentage()

  const body = {
    publishType,
    skipReview,
    blockOnWarnings,
  }
  if (deployPercentage !== null) body.deployInfos = [{ deployPercentage }]
  return body
}

async function parseResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function formatPayload(payload) {
  if (typeof payload === "string") return payload
  return JSON.stringify(payload, null, 2)
}

async function requestJson(url, { method = "GET", token, headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body,
  })
  const payload = await parseResponse(response)
  if (!response.ok) {
    throw new Error(`${method} ${url} failed with ${response.status}\n${formatPayload(payload)}`)
  }
  return payload
}

async function getAccessToken() {
  if (process.env.CHROME_WEBSTORE_ACCESS_TOKEN) return process.env.CHROME_WEBSTORE_ACCESS_TOKEN

  const clientId = requireValue("CHROME_WEBSTORE_CLIENT_ID", process.env.CHROME_WEBSTORE_CLIENT_ID)
  const clientSecret = requireValue(
    "CHROME_WEBSTORE_CLIENT_SECRET",
    process.env.CHROME_WEBSTORE_CLIENT_SECRET,
  )
  const refreshToken = requireValue(
    "CHROME_WEBSTORE_REFRESH_TOKEN",
    process.env.CHROME_WEBSTORE_REFRESH_TOKEN,
  )

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  })
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  const payload = await parseResponse(response)
  if (!response.ok) {
    throw new Error(`OAuth token refresh failed with ${response.status}\n${formatPayload(payload)}`)
  }
  if (!payload?.access_token) throw new Error(`OAuth response did not include access_token`)
  return payload.access_token
}

function printJson(label, payload) {
  console.log(`${label}:`)
  console.log(formatPayload(payload))
}

function uploadState(payload) {
  return payload?.uploadState || payload?.lastAsyncUploadState || ""
}

function isUploadInProgress(state) {
  return state === "IN_PROGRESS" || state === "UPLOAD_IN_PROGRESS"
}

function isUploadSucceeded(state) {
  return state === "SUCCEEDED"
}

function isUploadFailed(state) {
  return state === "FAILED" || state === "NOT_FOUND"
}

async function fetchStatus(token, ids) {
  return await requestJson(endpoint(ids, "fetchStatus"), { token })
}

async function uploadPackage(token, ids, artifactPath) {
  const bytes = readFileSync(artifactPath)
  const payload = await requestJson(endpoint(ids, "upload", true), {
    method: "POST",
    token,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.length),
    },
    body: bytes,
  })
  if (payload?.crxVersion && payload.crxVersion !== manifest.version) {
    throw new Error(
      `Uploaded version ${payload.crxVersion} does not match extension/manifest.json ${manifest.version}`,
    )
  }
  return payload
}

async function waitForUpload(token, ids, initialPayload) {
  let state = uploadState(initialPayload)
  if (isUploadSucceeded(state)) return initialPayload
  if (isUploadFailed(state)) throw new Error(`Upload failed: ${formatPayload(initialPayload)}`)
  if (!isUploadInProgress(state)) return initialPayload

  const attempts = Number(process.env.CHROME_WEBSTORE_UPLOAD_POLL_ATTEMPTS || 24)
  const delayMs = Number(process.env.CHROME_WEBSTORE_UPLOAD_POLL_DELAY_MS || 5000)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs))
    const status = await fetchStatus(token, ids)
    state = uploadState(status)
    console.log(`Upload processing state: ${state || "unknown"} (${attempt}/${attempts})`)
    if (isUploadSucceeded(state)) return status
    if (isUploadFailed(state)) throw new Error(`Upload failed: ${formatPayload(status)}`)
    if (!isUploadInProgress(state)) return status
  }
  throw new Error(`Timed out waiting for Chrome Web Store upload processing to finish.`)
}

async function publishItem(token, ids) {
  return await requestJson(endpoint(ids, "publish"), {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(publishBody()),
  })
}

function dryRunSummary(ids, artifactPath) {
  const summary = {
    command,
    publisherId: ids.publisherId,
    extensionId: ids.extensionId,
    manifestVersion: manifest.version,
  }
  if (artifactPath) {
    summary.artifact = basename(artifactPath)
    summary.bytes = statSync(artifactPath).size
  }
  if (command === "publish" || command === "submit") summary.publishBody = publishBody()
  printJson("Chrome Web Store dry run", summary)
}

async function main() {
  if (manifest.version !== pkg.version) {
    throw new Error(`version mismatch: manifest=${manifest.version}, package=${pkg.version}`)
  }

  if (!["help", "status", "upload", "publish", "submit"].includes(command)) {
    usage()
    throw new Error(`Unknown command: ${command}`)
  }
  if (command === "help") {
    usage()
    return
  }
  if (typeof fetch !== "function") throw new Error("Node.js 18+ is required for fetch().")

  const dryRun = hasFlag("--dry-run") || parseBool(process.env.CHROME_WEBSTORE_DRY_RUN, false)
  const ids = storeIds(!dryRun)
  const artifactPath = command === "upload" || command === "submit" ? resolveZipPath() : null

  if (dryRun) {
    dryRunSummary(ids, artifactPath)
    return
  }

  const token = await getAccessToken()
  if (command === "status") {
    printJson("Chrome Web Store status", await fetchStatus(token, ids))
    return
  }

  if (command === "upload") {
    const upload = await uploadPackage(token, ids, artifactPath)
    printJson("Chrome Web Store upload", upload)
    printJson("Chrome Web Store upload status", await waitForUpload(token, ids, upload))
    return
  }

  if (command === "publish") {
    printJson("Chrome Web Store publish", await publishItem(token, ids))
    return
  }

  const upload = await uploadPackage(token, ids, artifactPath)
  printJson("Chrome Web Store upload", upload)
  printJson("Chrome Web Store upload status", await waitForUpload(token, ids, upload))
  printJson("Chrome Web Store publish", await publishItem(token, ids))
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
