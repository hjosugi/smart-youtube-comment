import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"

const root = resolve(new URL("..", import.meta.url).pathname)
const extensionDir = resolve(root, "extension")
const releaseDir = resolve(root, ".release")
const manifestPath = resolve(extensionDir, "manifest.json")
const packagePath = resolve(root, "package.json")

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
const pkg = JSON.parse(readFileSync(packagePath, "utf8"))

if (manifest.version !== pkg.version) {
  throw new Error(`version mismatch: manifest=${manifest.version}, package=${pkg.version}`)
}

const required = [
  "manifest.json",
  "background.js",
  "scoring.js",
  "danmaku.js",
  "settings.js",
  "filter.js",
  "content.js",
  "options.html",
  "options.js",
  "_locales",
  "icons",
]

for (const file of required) {
  const path = resolve(extensionDir, file)
  if (!existsSync(path)) throw new Error(`missing release file: extension/${file}`)
  if (statSync(path).size === 0) throw new Error(`empty release file: extension/${file}`)
}

mkdirSync(releaseDir, { recursive: true })

const artifactName = `${pkg.name}-v${manifest.version}.zip`
const artifactPath = resolve(releaseDir, artifactName)
const baseName = `${pkg.name}-v${manifest.version}`
const checksumPath = resolve(releaseDir, `${baseName}.sha256`)
const metadataPath = resolve(releaseDir, `${baseName}.release.json`)
const notesPath = resolve(releaseDir, `${baseName}-notes.md`)
const testerGuidePath = resolve(releaseDir, `${baseName}-tester-install.md`)
rmSync(artifactPath, { force: true })
rmSync(checksumPath, { force: true })
rmSync(metadataPath, { force: true })
rmSync(notesPath, { force: true })
rmSync(testerGuidePath, { force: true })

execFileSync("zip", ["-X", "-r", artifactPath, ...required], {
  cwd: extensionDir,
  stdio: "inherit",
})

execFileSync("unzip", ["-t", artifactPath], {
  stdio: "inherit",
})

const verifyDir = mkdtempSync(resolve(tmpdir(), `${baseName}-`))
try {
  execFileSync("unzip", ["-q", artifactPath, "-d", verifyDir], {
    stdio: "inherit",
  })
  for (const file of required) {
    const path = resolve(verifyDir, file)
    if (!existsSync(path)) throw new Error(`zip verification failed; missing ${file}`)
    if (statSync(path).size === 0) throw new Error(`zip verification failed; empty ${file}`)
  }
} finally {
  rmSync(verifyDir, { recursive: true, force: true })
}

const artifactBytes = readFileSync(artifactPath)
const sha256 = createHash("sha256").update(artifactBytes).digest("hex")
const size = statSync(artifactPath).size
const createdAt = new Date().toISOString()

writeFileSync(checksumPath, `${sha256}  ${artifactName}\n`)

writeFileSync(
  metadataPath,
  `${JSON.stringify(
    {
      name: pkg.name,
      version: manifest.version,
      createdAt,
      artifact: artifactName,
      sha256,
      bytes: size,
      files: required,
    },
    null,
    2,
  )}\n`,
)

writeFileSync(
  notesPath,
  `# ${manifest.name} v${manifest.version}

## Artifact

- File: \`${artifactName}\`
- SHA-256: \`${sha256}\`
- Size: ${size} bytes
- Created: ${createdAt}

## Validation

- Security policy check: included in \`npm run release:zip\`
- Local sandbox smoke: included in \`npm run release:zip\`
- Zip integrity: included in \`npm run release:zip\`
- Zip extraction verification: included in \`npm run release:zip\`

## Manual Smoke Test

- [ ] Load \`extension/\` unpacked in Chrome
- [ ] Open a YouTube live stream with active chat
- [ ] Confirm comments render over the video
- [ ] Confirm short/emoji-heavy messages move faster
- [ ] Confirm longer informative messages move slower
- [ ] Check top page and chat iframe DevTools consoles
- [ ] Record Chrome version, OS, stream URL, and observed issues

## Known Limitations

- Prototype build
- YouTube DOM changes may break extraction
- Busy-stream performance still needs real Chrome profiling
- Not yet ready for Chrome Web Store submission
`,
)

writeFileSync(
  testerGuidePath,
  `# Tester Install: ${manifest.name} v${manifest.version}

## Install

1. Unzip \`${artifactName}\`.
2. Open \`chrome://extensions\`.
3. Enable Developer mode.
4. Click \`Load unpacked\`.
5. Select the unzipped folder.
6. Open a YouTube live stream with active chat.

## What To Check

- Comments appear over the video.
- Short/emoji-heavy comments move faster.
- Longer informative comments move slower.
- The page remains responsive during busy chat.
- The extension does not request network code.

## If It Fails

Please report:

- Chrome version
- OS
- stream URL
- screenshot or screen recording if possible
- top page console errors
- chat iframe console errors

## Artifact Verification

SHA-256:

\`\`\`text
${sha256}  ${artifactName}
\`\`\`
`,
)

console.log(`Release artifact: .release/${basename(artifactPath)} (${size} bytes)`)
console.log(`Checksum: .release/${basename(checksumPath)}`)
console.log(`Metadata: .release/${basename(metadataPath)}`)
console.log(`Notes: .release/${basename(notesPath)}`)
console.log(`Tester guide: .release/${basename(testerGuidePath)}`)
