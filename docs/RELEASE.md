<!-- i18n: language-switcher -->
[English](RELEASE.md) | [日本語](RELEASE.ja.md)

# Release Guide

This is the local release path for the JavaScript-only Chrome extension.

## Release Strategy

Use three stages:

1. **Local unpacked release**: load `extension/` directly in Chrome.
2. **Zip release**: create `.release/smart-youtube-comment-vX.Y.Z.zip` and share
   it with testers who can load unpacked extensions.
3. **Chrome Web Store release**: after the one-time store listing and OAuth
   setup, upload and publish through `scripts/chrome-webstore.mjs` or GitHub
   Actions.

The `.release/` directory is ignored by Git. Artifacts are reproducible from
tracked extension source; there is no build step.

## Versioning

Keep these versions identical:

- `package.json` -> `version`
- `web/package.json` -> `version`
- `worker/package.json` -> `version`
- `extension/manifest.json` -> `version`

Set all of them, plus lockfile root metadata, at once:

```sh
npm run version:set -- 0.1.1
```

For now, use simple semver:

- patch: docs, small bug fixes, threshold tuning
- minor: user-visible settings, rendering, filtering, or UI features
- major: contract or storage changes that break compatibility

## Pre-Release Checklist

Install every package root before running local release checks:

```sh
npm ci
npm --prefix web ci
npm --prefix worker ci
```

Run:

```sh
npm run release:check
```

This runs:

- lint and format checks
- security and supply-chain policy checks
- root and worker typechecks
- web build
- unit, deterministic, and browser e2e suites
- local sandbox server smoke test

Optional but useful:

```sh
npm run test:e2e
npm run test:ext
```

`test:ext` opens a real Chromium with the unpacked extension and may require a
desktop session. It uses deterministic fake YouTube pages for the overlay/chat
path by default.

Opt-in real YouTube smoke:

```sh
SYC_REAL_YOUTUBE_URL="https://www.youtube.com/watch?v=..." npm run test:ext:youtube
```

Use a public live stream with active chat. This is intentionally outside
`release:check` because it depends on YouTube availability, geo/account state,
and whether chat is active during the run.

Manual network probes are intentionally not part of `release:check` because
they depend on real YouTube availability and network behavior:

- `worker/test/probe.mjs`: one-shot relay probe for a known video/live URL.
- `worker/test/loadtest.mjs`: relay pressure test for latency and retry tuning.
- `web/test/chat-client-live.mjs`: browser-side live chat client smoke check.

Run them before a release candidate when a valid public video/live URL is
available. Keep CI deterministic and fixture-backed.

## Build The Zip

Run:

```sh
npm run release:zip
```

Output:

```text
.release/smart-youtube-comment-v0.1.0.zip
```

The release script automatically creates:

- `.release/smart-youtube-comment-vX.Y.Z.zip`
- `.release/smart-youtube-comment-vX.Y.Z.sha256`
- `.release/smart-youtube-comment-vX.Y.Z.release.json`
- `.release/smart-youtube-comment-vX.Y.Z-notes.md`
- `.release/smart-youtube-comment-vX.Y.Z-tester-install.md`

The zip contains only the extension files listed by `scripts/package-extension.mjs`.

## Chrome Web Store Automation

See `docs/STORE_AUTOMATION.md` for the one-time setup, OAuth details, and CI
release path.

For the no-thinking manual checklist, use `docs/STORE_RELEASE_RUNBOOK_JA.md`.

Once the GitHub repository secrets are configured, pushing a matching `vX.Y.Z`
tag runs checks, packages the extension, uploads release artifacts, uploads the
zip to Chrome Web Store, and submits it for review/publishing.

Preferred CI auth uses a service account plus GitHub OIDC:

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

Refresh-token fallback:

```text
CHROME_WEBSTORE_PUBLISHER_ID
CHROME_WEBSTORE_EXTENSION_ID
CHROME_WEBSTORE_CLIENT_ID
CHROME_WEBSTORE_CLIENT_SECRET
CHROME_WEBSTORE_REFRESH_TOKEN
```

Local one-command store release:

```sh
npm run release:store
```

Upload-only and publish-after-upload are split for safer recovery:

```sh
npm run release:store:upload
npm run release:store:publish
```

## Manual Browser Smoke Test

Before sharing a zip:

1. Run `npm run release:zip`.
2. Run `npm run sandbox` and open `http://127.0.0.1:4173/`.
3. Confirm the local sandbox renders comments with the JS scorer.
4. Open `chrome://extensions`.
5. Enable Developer mode.
6. Remove any older loaded copy of this extension.
7. Load the `extension/` directory as unpacked.
8. Open a YouTube live stream with active chat.
9. Confirm comments render over the video.
10. Confirm the seekbar-area danmaku toggle works.
11. Confirm default chat hide/show behavior follows settings.
12. Confirm official YouTube guide/warning/recommendation text is not rendered.
13. Wait several minutes and confirm new comments keep flowing.
14. Confirm CPU usage and video controls remain reasonable with busy chat.

## Tester Instructions

For testers, prefer sending:

- the zip artifact from `.release/`
- the generated `.sha256`
- the generated tester install guide
- short install instructions
- known limitations
- a request for Chrome version, OS, stream URL, and console errors if it fails

Tester install flow:

1. Unzip the artifact.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select the unzipped folder.

## Known Release Limitations

Do not present this as production-ready yet:

- YouTube DOM changes may break extraction
- performance still needs real busy-stream profiling
- YouTube pop-out chat tabs are not supported because the renderer needs the
  original watch page's video player
- Chrome Web Store listing assets, privacy copy, and data-use declarations still
  require one-time dashboard setup
- real-YouTube smoke is opt-in because it depends on a currently active public
  stream with accessible chat

## Store Release Gate

Submit store releases only after these are done:

- real-stream smoke test on multiple streams
- concise privacy note: all scoring/filtering is local and no network calls are
  made by the extension
- rollback plan for YouTube DOM breakage
- one-time Chrome Web Store listing and OAuth setup from `docs/STORE_AUTOMATION.md`
- a tagged Git release matching the manifest version

## Rollback

If a release build is bad:

1. Stop sharing the zip.
2. Keep the bad artifact only if needed for debugging.
3. Fix source.
4. Bump patch version.
5. Re-run `npm run release:zip` or `npm run release:store`.

For unpacked testers, ask them to remove the old extension and load the new
unzipped folder.
