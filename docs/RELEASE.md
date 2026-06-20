# Release Guide

This is the local release path for the JavaScript-only Chrome extension.

## Release Strategy

Use three stages:

1. **Local unpacked release**: load `extension/` directly in Chrome.
2. **Zip release**: create `.release/smart-youtube-comment-vX.Y.Z.zip` and share
   it with testers who can load unpacked extensions.
3. **Store release later**: only after real YouTube live-stream smoke tests,
   stable settings, and basic privacy/release copy are ready.

The `.release/` directory is ignored by Git. Artifacts are reproducible from
tracked extension source; there is no Rust/WASM build step.

## Versioning

Keep these versions identical:

- `package.json` -> `version`
- `extension/manifest.json` -> `version`

Set both at once:

```sh
npm run version:set -- 0.1.1
```

For now, use simple semver:

- patch: docs, small bug fixes, threshold tuning
- minor: user-visible settings, rendering, filtering, or UI features
- major: contract or storage changes that break compatibility

## Pre-Release Checklist

Run:

```sh
npm run release:check
```

This runs:

- security and supply-chain policy checks
- local sandbox server smoke test

Optional but useful:

```sh
npm run test:e2e
npm run test:ext
```

`test:ext` opens a real Chromium with the unpacked extension and may require a
desktop session.

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
It must not contain `wasm/comment_scorer.wasm`.

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
- no Chrome Web Store listing assets or privacy copy yet
- no automated real-YouTube smoke test yet

## Store Release Gate

Defer a store release until these are done:

- real-stream smoke test on multiple streams
- concise privacy note: all scoring/filtering is local and no network calls are
  made by the extension
- rollback plan for YouTube DOM breakage
- a tagged Git release matching the manifest version

## Rollback

If a release build is bad:

1. Stop sharing the zip.
2. Keep the bad artifact only if needed for debugging.
3. Fix source.
4. Bump patch version.
5. Re-run `npm run release:zip`.

For unpacked testers, ask them to remove the old extension and load the new
unzipped folder.
