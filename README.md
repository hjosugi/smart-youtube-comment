# Smart YouTube Comment Overlay

Chrome MV3 extension prototype for a Nico-style YouTube live chat overlay. It
scores messages locally in JavaScript and uses that score to decide whether a
comment should move quickly, normally, or slowly across the video.

The goal is to keep useful comments visible without letting short repeated
reactions, emoji floods, or low-value bursts bury everything else.

## Status

Implemented:

- Chrome MV3 extension scaffold
- mobile PWA under `web/`
- Cloudflare Worker live-chat relay under `worker/`
- YouTube live-chat extraction from all frames
- top-frame canvas danmaku renderer
- JavaScript-only local scorer in `extension/scoring.js`
- settings and filter UI
- local sandbox and renderer performance probes
- release zip packaging
- security/supply-chain checks

Browser extraction and rendering are the practical bottlenecks, so scoring is
kept small and local.

## How It Works

The extension runs `extension/content.js` in every YouTube frame.

1. Chat frames watch YouTube live-chat renderer nodes.
2. Each new chat message is normalized into a `ScoreInput`.
3. `extension/scoring.js` returns a local `ScoreResult`.
4. `buildRenderPlan()` maps the result into fast / normal / slow display timing.
5. A background service worker relays messages from chat frames to the top video
   frame.
6. The top frame renders comments over the YouTube player.

The extension does not fetch remote code.

## Privacy And Storage

The extension scores, filters, and renders comments locally in the browser.
Display, behavior, and performance settings are saved with Chrome Sync storage
when available, so Chrome may sync those settings across the signed-in profile.
Blocked users and blocked words are saved only in local extension storage on the
current device. Chat text, author names, and block lists are not sent to the
developer.

## Requirements

- Chrome or Chromium for loading the extension
- Node.js 22+ and npm 10+ for scripts
- Optional: Bun 1.3+ for faster local scripts

Install JS tooling:

```sh
npm install
```

## Test

Run the security gate, typecheck, web build, unit suites, browser e2e suites
when Chromium is installed, and sandbox smoke checks:

```sh
npm test
```

Run the security gate directly:

```sh
npm run security
```

Bun equivalents:

```sh
bun run test:bun
bun run security:bun
```

Renderer performance probe:

```sh
npm run test:e2e
```

Real extension smoke test in Chromium:

```sh
npm run test:ext
```

`test:ext` opens a real browser locally. In CI it skips by default unless
`SYC_REQUIRE_EXTENSION_E2E=1` is set. To make `npm test` fail instead of
skipping missing Chromium, set `SYC_REQUIRE_E2E=1`.

## Worker Relay

The Cloudflare Worker under `worker/` relays YouTube InnerTube live-chat calls.
It defaults to the checked-in WEB client version, but production can override it
without a code change:

```sh
wrangler deploy --var INNERTUBE_CLIENT_VERSION:2.20260705.00.00
```

`GET /health` returns the effective and default InnerTube client versions.
`GET /health?deep=1&video=<11-char-id>` runs a canary `next` probe with the same
effective client version; use it from an external scheduled monitor or Cloudflare
Cron Trigger to detect client-version rejection before viewers hit it.

## Local Sandbox

Run:

```sh
npm run sandbox
```

Then open:

```text
http://127.0.0.1:4173/
```

The sandbox serves `sandbox/index.html`, loads the shared JS scorer, simulates
live chat, and renders comments over a fake video surface.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `extension` directory.
5. Open a YouTube live stream with live chat.

After changing content scripts or manifest files, reload the extension in
`chrome://extensions` and reload the YouTube tab.

Expected behavior:

- comments appear over the video in danmaku style
- short or spammy messages move faster
- higher-quality or emphasized messages move slower
- the seekbar-area toggle can hide/show danmaku
- default YouTube chat hide/show follows settings

## Release Build

Create a tester zip:

```sh
npm run release:zip
```

Bun path:

```sh
bun run release:zip:bun
```

Artifacts are written to `.release/`, which is ignored by Git. See
[docs/RELEASE.md](docs/RELEASE.md).

Set package and manifest versions together:

```sh
npm run version:set -- 0.1.1
```

This updates the root, `web/`, `worker/`, their lockfile root metadata, and
`extension/manifest.json`.

## Project Layout

```text
.
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── scoring.js
│   ├── danmaku.js
│   ├── settings.js
│   ├── filter.js
│   ├── content.js
│   ├── options.html
│   ├── options.js
│   └── icons/
├── bench/
│   ├── danmaku-bench.html
│   └── e2e/
├── web/
│   ├── app.ts
│   ├── test/
│   └── dist/
├── worker/
│   ├── src/
│   ├── test/
│   └── wrangler.jsonc
├── sandbox/
│   └── index.html
├── docs/
│   ├── CONTRACT.md
│   ├── PERFORMANCE.md
│   ├── RELEASE.md
│   └── SECURITY.md
└── scripts/
    ├── check-sandbox.mjs
    ├── package-extension.mjs
    ├── security-check.mjs
    ├── serve-sandbox.mjs
    └── set-version.mjs
```

## Current Performance Focus

Scoring is intentionally small and local. The next wins are in:

- YouTube chat extraction robustness
- queue/ring-buffer behavior
- text rasterization budget
- canvas draw loop
- Long Task and frame p95/p99 diagnostics
- keeping `maxActive=2000` responsive through admission control

More notes are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## License

0BSD. You can use, copy, modify, and distribute this project for almost any purpose.
